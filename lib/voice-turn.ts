import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dataPath } from "@/lib/data-dir";
import { pingDiscord } from "@/lib/ping-discord";
import { autoRecall } from "@/lib/brain";
import { getUserConfig } from "@/lib/user-config";
import { recentBuffer } from "@/lib/recent";
import { buildSessionPreamble } from "@/lib/preamble";
import { computeCareSignals, renderCareSignals } from "@/lib/care-signals";
import { getMacContext, fenceMacContext } from "@/lib/context";
import { getProvider } from "@/lib/providers";
import { appendJournal } from "@/lib/journal";
import { clearKill, engageKill, matchKillCommand } from "@/lib/kill";
import { matchFleetIntent } from "@/lib/agents/intents";
import { normalizeEffort, normalizeMode } from "@/lib/models";
import { computeFingerprint, shouldResumeSession } from "@/lib/session-fingerprint";
import { addCommitment, resolveCommitment } from "@/lib/commitments";
import { confirmPending, cancelPending } from "@/lib/confirm";
import {
  createThread,
  getThread,
  listThreads,
  saveThread,
  updateThread,
  withTurnLock,
} from "@/lib/store";
import { handleFleetIntent } from "@/lib/voice-fleet";
import { personaToneBlock, readProfile } from "@/lib/onboarding";
import { assistantPersonaNameBlock } from "@/lib/chat-system-text";
import { plainLanguageProviderError } from "@/lib/provider-error";
import { recordProviderDiag } from "@/lib/diag-ledger";
import { isOwner } from "@/lib/user-config";
import { fenceUntrusted, stripLeadingControlTokens } from "@/lib/untrusted";
import { matchFixitIntent } from "@/lib/fixit-intents";
import { runFixitCommand } from "@/lib/fixit-registry";

/**
 * The shared voice turn — ONE brain for the Mac menu-bar app (SSE, via
 * /api/voice-command) and the phone Shortcut (plain JSON, via /api/phone/ask).
 * Both land on the SAME persistent "voice" thread so a command started on the
 * Mac and a follow-up from the phone are one conversation, not two.
 *
 * runVoiceTurn resolves to the final spoken string (already stripped of any
 * control markers). The SSE route passes an onDelta callback to stream tokens
 * as they arrive AND still emits its frozen ack/delta/result contract by
 * wrapping this; the phone route passes no callback and just returns the text.
 *
 * Everything here is fail-open: a failure is delivered AS the spoken result
 * (never thrown), because the caller's job is to always hand something
 * speakable back to the user.
 */

const VOICE_THREAD_TITLE = "voice";
/** A conversation older than this is a new sitting — it gets the session
 *  preamble again. Resumed CLI sessions younger than this already carry it. */
const PREAMBLE_FRESH_AFTER_MS = 45 * 60 * 1000;

/**
 * The voice system text. Appended (not replaced) with recall/recent/preamble
 * per turn. The COMMIT marker protocol (B4) lets Vidi record and resolve the
 * promises she makes out loud; the markers are parsed and STRIPPED before the
 * result is ever spoken (see stripCommitmentMarkers).
 */
export function buildVoiceSystemText(): string {
  // Resolved at call time (not module load) so a second user's display name —
  // written by onboarding after this module is first imported — reaches the
  // prompt. getUserConfig is memoized and reset on config writes.
  const displayName = getUserConfig().displayName;
  return (
    "voice mode: your reply will be spoken aloud — 1-3 short sentences, no " +
    "markdown or lists, written for the ear; for long-running work say what " +
    "you did and what remains.\n" +
    `You share history with ${displayName} — reference it naturally and specifically, ` +
    "don't recite it.\n" +
    "If you promise to do something later, end your reply with a marker of the " +
    "exact form [COMMIT: <what> | <when>] (e.g. [COMMIT: check the deploy logs | " +
    "tonight]). When you fulfill a promise you made earlier, end your reply with " +
    "[COMMIT-DONE: <what>]. These markers are stripped before your reply is " +
    "spoken — never mention them, and put them only at the very end."
  );
}

const VOICE_MODELS = new Set(["auto", "fable", "opus", "sonnet"]);

export function findOrCreateVoiceThread() {
  const meta = listThreads().find(
    (m) => m.title === VOICE_THREAD_TITLE && m.provider === "claude"
  );
  if (meta) {
    const t = getThread(meta.id);
    if (t) return t;
  }
  // "auto" model; the DEFAULT thread MODE depends on who owns this install
  // (Phase 4a): the owner keeps the acting default ("auto"); a NON-owner
  // install defaults to Plan mode. As of P5 the Plan/Auto toggle no longer
  // lets a non-owner GRANT themself act mode — the provider clamps any "auto"
  // request to Plan unless the OWNER opted them in (VIDI_ACT_OPT_IN; see
  // actModeAllowed in user-config.ts). The toggle still reflects intent, but
  // acting stays behind the owner's approval.
  const defaultVoiceMode = isOwner() ? "auto" : "plan";
  const t = createThread("claude", "auto", defaultVoiceMode);
  t.title = VOICE_THREAD_TITLE;
  saveThread(t);
  return t;
}

/* -------------------------------------------------------------------------- */
/* Commitment markers (B4)                                                    */
/* -------------------------------------------------------------------------- */

// Vidi ends a reply with [COMMIT: <what> | <when>] when she promises something
// for later, and [COMMIT-DONE: <what>] when she pays one back. We parse both
// out of the FINAL result text, record them into the ledger, and strip the
// markers so they're never spoken — the exact mirror of how the Swift app
// strips [POINT: …] gaze markers before TTS.
const COMMIT_RE = /\[COMMIT:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/gi;
const COMMIT_DONE_RE = /\[COMMIT-DONE:\s*([^\]]+?)\s*\]/gi;

/**
 * Record any COMMIT / COMMIT-DONE markers found in `text` and return the text
 * with every marker removed and whitespace tidied. Fail-open: a ledger write
 * that throws must not break the reply, so each side effect is guarded.
 */
export function stripCommitmentMarkers(text: string): string {
  // COMMIT-DONE first: resolving a promise shouldn't be shadowed by a same-turn
  // new promise, and the two regexes don't overlap anyway.
  let m: RegExpExecArray | null;
  COMMIT_DONE_RE.lastIndex = 0;
  while ((m = COMMIT_DONE_RE.exec(text)) !== null) {
    const what = (m[1] || "").trim();
    if (what) {
      try {
        resolveCommitment(what);
      } catch {
        /* fail-open: an unresolved promise is better than a broken reply */
      }
    }
  }
  COMMIT_RE.lastIndex = 0;
  while ((m = COMMIT_RE.exec(text)) !== null) {
    const what = (m[1] || "").trim();
    const when = (m[2] || "").trim();
    if (what) {
      try {
        addCommitment({ text: what, due: when || undefined, source: "voice" });
      } catch {
        /* fail-open */
      }
    }
  }

  // Strip both marker forms, then collapse the whitespace the removal leaves.
  return text
    .replace(COMMIT_DONE_RE, "")
    .replace(COMMIT_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Brief me — read out and clear the queued proactivity items                 */
/* -------------------------------------------------------------------------- */

function eventsDir(): string {
  // Shared dataDir() (VIDI_DATA_DIR override, else <cwd>/data) — unset resolves
  // byte-identically to <cwd>/data/events.
  return dataPath("events");
}

/**
 * Read data/events/queued.jsonl. Returns the parsed events plus their raw
 * lines (so we can rewrite the file removing exactly what we delivered).
 * Fail-open: an unreadable/absent queue is simply "nothing waiting".
 */
function readQueuedEvents(): Array<{ raw: string; event: any }> {
  let raw: string;
  try {
    raw = readFileSync(path.join(eventsDir(), "queued.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: Array<{ raw: string; event: any }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push({ raw: line, event: JSON.parse(trimmed) });
    } catch {
      /* skip a malformed line rather than lose the whole queue */
    }
  }
  return out;
}

/**
 * Mark the given queued events delivered: append them to log.jsonl and rewrite
 * queued.jsonl with them removed. Fail-open — losing this bookkeeping at worst
 * re-briefs an item next time, never breaks the reply.
 */
function markQueuedDelivered(delivered: Array<{ raw: string; event: any }>): void {
  if (!delivered.length) return;
  try {
    mkdirSync(eventsDir(), { recursive: true });
  } catch {
    /* directory may already exist */
  }
  const deliveredRaws = new Set(delivered.map((d) => d.raw));
  const nowIso = new Date().toISOString();
  try {
    for (const d of delivered) {
      appendFileSync(
        path.join(eventsDir(), "log.jsonl"),
        JSON.stringify({ ...d.event, delivery: "brief-me", deliveredAt: nowIso }) + "\n"
      );
    }
  } catch {
    /* best-effort log */
  }
  try {
    // Re-read + rewrite so any lines the broker queued between our read and now
    // survive; only remove the exact lines we just delivered.
    const remaining = readQueuedEvents()
      .filter((e) => !deliveredRaws.has(e.raw))
      .map((e) => e.raw)
      .join("\n");
    writeFileSync(
      path.join(eventsDir(), "queued.jsonl"),
      remaining ? remaining + "\n" : ""
    );
  } catch {
    /* fail-open: a failed truncate just means one re-brief later */
  }
}

/**
 * Build the "brief me" reply. Either a synchronous "nothing waiting" string, or
 * a { rewritePrompt } that hands the queued items to a normal act turn for a
 * short spoken digest (same pattern as the standing report). Delivered items
 * are moved out of the queue as a side effect.
 */
function buildBriefMe(): string | { rewritePrompt: string } {
  const queued = readQueuedEvents();
  if (!queued.length) return "Nothing's waiting.";

  const lines = queued.map((q, i) => {
    const e = q.event || {};
    const label: string =
      (typeof e.spoken === "string" && e.spoken.trim()) ||
      (typeof e.title === "string" && e.title.trim()) ||
      "an item";
    const detail = typeof e.detail === "string" && e.detail.trim() ? ` (${e.detail.trim()})` : "";
    return `${i + 1}. ${label}${detail}`;
  });

  // Move them to delivered BEFORE composing — brief-me is the delivery, so a
  // re-ask shouldn't replay the same backlog.
  markQueuedDelivered(queued);

  return {
    rewritePrompt:
      `Give ${getUserConfig().displayName} a short spoken digest of what was waiting for them while they ` +
      `were away. There ${queued.length === 1 ? "is 1 item" : `are ${queued.length} items`} ` +
      `below — summarize them naturally in 1-3 sentences for the ear, lead with ` +
      `anything urgent, no lists or numbering.\n\n` +
      // H9: the queued items are ingested event text — fence them as data.
      fenceUntrusted("waiting items", lines.join("\n")),
  };
}

/* -------------------------------------------------------------------------- */
/* Kill switch (LLM-free)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a kill-switch command to spoken text. Matched by the caller BEFORE
 * any thread/provider work so it still works when quota is exhausted.
 */
function killSwitchText(action: "engage" | "clear", transcript: string): string {
  let text: string;
  if (action === "engage") {
    const { killed } = engageKill(`voice: "${transcript.slice(0, 120)}"`);
    text =
      killed > 0
        ? `Stopped — killed ${killed} running ${killed === 1 ? "process" : "processes"} and engaged the kill switch. Say "clear the kill switch" when you want me back.`
        : `Nothing was running, but the kill switch is engaged — no new runs until you say "clear the kill switch".`;
  } else {
    text = clearKill()
      ? "Kill switch cleared. I'm back."
      : "The kill switch wasn't engaged — nothing to clear.";
  }
  pingDiscord(`Vidi kill switch ${action}: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  return text;
}

/* -------------------------------------------------------------------------- */
/* The shared turn                                                            */
/* -------------------------------------------------------------------------- */

export interface RunVoiceTurnOpts {
  /** Harness overrides from the caller (Mac app / phone). */
  mode?: unknown;
  model?: unknown;
  effort?: unknown;
  /** Streamed token callback; the SSE route uses it, the phone route omits it. */
  onDelta?: (text: string) => void;
  /** Called once the turn commits to running an LLM turn (SSE emits `ack`). For
   *  synchronous intercepts (kill/confirm/fleet) it fires before returning too,
   *  so the SSE contract always leads with exactly one ack. */
  onAck?: () => void;
  /** Abort signal (consumer disconnect) — forwarded to the CLI child. */
  signal?: AbortSignal;
  /**
   * B1 (Layer B) — did THIS request carry a valid control token? Set by the
   * route from verifyControlToken(req). Approving a parked confirm action
   * requires it: a tokenless local POST forging {"transcript":"confirm"} must
   * NOT approve a pending action (the whole B1 forge). The owner's Swift app
   * attaches the token when it forwards a spoken "confirm"; a blind POST can't.
   */
  controlAuthorized?: boolean;
  /**
   * B1 (Layer A) — the per-command nonce the caller presents to approve the
   * parked action (machine-carried by the Swift overlay, never spoken). Checked
   * against the pending record's nonce in confirmPending. Absent → the approval
   * is rejected even with a valid token (correct token + wrong/no nonce → no run).
   */
  approvalNonce?: string;
}

/**
 * Run one voice turn end-to-end and resolve to the final spoken text.
 *
 * Order matters and mirrors the frozen route: kill switch → confirm/cancel
 * intercepts → other fleet commands → memory recall → act turn on the voice
 * thread. Confirm/cancel are intercepted HERE, before any other intent, so a
 * bare "confirm" can never be swallowed by another rule.
 */
export async function runVoiceTurn(
  transcript: string,
  opts: RunVoiceTurnOpts = {}
): Promise<string> {
  const ack = () => {
    try {
      opts.onAck?.();
    } catch {
      /* the ack callback must never break the turn */
    }
  };

  // 1) LLM-free emergency stop — before any thread/provider work.
  const killAction = matchKillCommand(transcript);
  if (killAction) {
    ack();
    return killSwitchText(killAction, transcript);
  }

  // 2) Confirm-tier intercepts FIRST among intents: a bare "confirm" / "cancel
  //    that" clears the one-slot pending action and must never fall through to
  //    another rule. confirmPending runs the parked action and returns its
  //    spoken result; cancelPending is synchronous.
  const intent = matchFleetIntent(transcript);
  if (intent?.kind === "confirm") {
    ack();
    // B1 (Layer B): a parked action only runs when the request proves it came
    // from the trusted UI — a valid control token AND the per-command nonce.
    // A tokenless/blind local POST forging {"transcript":"confirm"} lands here
    // but is refused (spoken, no oracle) without ever touching the pending slot.
    if (!opts.controlAuthorized) {
      return "I can only act on that from the Vidi app on this Mac — I didn't get a confirmation I can trust.";
    }
    try {
      return (await confirmPending(Date.now(), { nonce: opts.approvalNonce })).text;
    } catch {
      return "Nothing is waiting on you.";
    }
  }
  if (intent?.kind === "cancelPending") {
    ack();
    try {
      return cancelPending().text;
    } catch {
      return "There was nothing to cancel.";
    }
  }

  // 2b) Fix-It Mode (T0 read-only) — mapped from plain-language "something's
  //    broken" onto ONE named command from the fixed server-side registry
  //    (PLAN-VIDI-FIXIT.md §4.1 / §6 Phase A). Runs HERE, after kill/confirm/
  //    cancel and alongside the fleet intents, before the act turn.
  //
  //    §4.3 (CRITICAL): fix-it matching runs ONLY on the LIVE user transcript,
  //    never on fenced/untrusted content — `transcript` is exactly that live
  //    text (recalled brain hits, the 48h buffer, emails and agent reports are
  //    fenced downstream via fenceUntrusted and are never passed here). We run
  //    stripLeadingControlTokens first (belt-and-suspenders) so a transcribed
  //    "system: …" prefix can't masquerade as a control token. A miss falls
  //    through — the matcher never guesses. Every Phase A command is T0, so a
  //    match runs with no approval; the worst case is speaking a status line.
  const fixitIntent = matchFixitIntent(stripLeadingControlTokens(transcript));
  if (fixitIntent) {
    ack();
    try {
      return await runFixitCommand(fixitIntent.commandId);
    } catch {
      // runFixitCommand already never throws, but stay fail-open into the turn.
      return "I tried to check that, but something got in the way.";
    }
  }

  // 3) Brief me — read out and clear the queued proactivity items. Either a
  //    synchronous "nothing waiting" or a rewritePrompt that runs an act turn.
  let rewritePrompt: string | null = null;
  if (intent?.kind === "briefMe") {
    const brief = buildBriefMe();
    if (typeof brief === "string") {
      ack();
      return brief;
    }
    rewritePrompt = brief.rewritePrompt;
  }

  // 4) All other fleet commands (spawn/ask/status/goals/sentry/macro/…). A
  //    string result resolves synchronously; a { rewritePrompt } swaps the
  //    prompt for a grounded act turn; null falls through to a normal turn. A
  //    throw here must never break the turn — treat it as "fall through".
  if (rewritePrompt === null && intent) {
    let fleetReply: string | { rewritePrompt: string } | null = null;
    try {
      fleetReply = await handleFleetIntent(intent, transcript);
    } catch {
      fleetReply = null;
    }
    if (typeof fleetReply === "string") {
      ack();
      return fleetReply;
    }
    if (fleetReply && typeof fleetReply === "object") {
      rewritePrompt = fleetReply.rewritePrompt;
    }
  }

  const isRewritten = rewritePrompt !== null;
  const effectiveTranscript = rewritePrompt ?? transcript;

  // 5) Automatic recall — only for a plain turn (rewritten prompts arrive
  //    already grounded). Fail-open, ~free.
  let recalledMemory: string | null = null;
  let recentContext: string | null = null;
  let macContext: string | null = null;
  if (!isRewritten) {
    [recalledMemory, recentContext, macContext] = await Promise.all([
      autoRecall(transcript).catch(() => null),
      Promise.resolve()
        .then(() => recentBuffer(transcript))
        .catch(() => null),
      // What's on the owner's screen right now (C1 context track), so answers
      // are pre-grounded. Fail-open: app down → null → turn proceeds unchanged.
      getMacContext().catch(() => null),
    ]);
  }

  const thread = findOrCreateVoiceThread();

  // Session preamble: once per conversation, not per turn.
  const lastMessageTs =
    thread.messages.length > 0 ? thread.messages[thread.messages.length - 1].ts : 0;
  const isFreshConversation =
    !thread.providerSessionId || Date.now() - lastMessageTs > PREAMBLE_FRESH_AFTER_MS;
  let sessionPreamble: string | null = null;
  if (isFreshConversation) {
    try {
      sessionPreamble = buildSessionPreamble() || null;
    } catch {
      sessionPreamble = null;
    }
  }

  let voiceSystemText = buildVoiceSystemText();
  // Personality tone (P4.1 onboarding): if the user picked a personality during
  // onboarding, append its one-line tone nudge. No profile → null → the
  // prompt is byte-identical to before. Fail-open: a read error just drops
  // the tone block, never breaks the turn.
  try {
    const toneBlock = personaToneBlock(readProfile());
    if (toneBlock) voiceSystemText += `\n\n${toneBlock}`;
  } catch {
    /* no tone block — default behavior */
  }
  // Persona name (2026-07-11): the voice customer names his assistant (e.g.
  // "Anna"), so the spoken persona must self-reference that name too. null on a
  // default install → byte-identical prompt. Fail-open like the tone block.
  try {
    const personaNameBlock = assistantPersonaNameBlock();
    if (personaNameBlock) voiceSystemText += `\n\n${personaNameBlock}`;
  } catch {
    /* no persona-name block — default behavior */
  }
  // Always give Vidi the current time — "what time is it" and any time-relative
  // question should be answered directly, never deflected to Siri. (The session
  // preamble also carries it, but only on fresh conversations, so inject it
  // here every turn.)
  voiceSystemText += `\n\nCurrent date and time: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}. If asked the time or date, just say it.`;
  // P6 injection-fence: the screen context (frontmost window title + AX digest)
  // is attacker-influenceable ingested content — fence it as data like every
  // other channel. fenceMacContext returns "" when there's no context.
  voiceSystemText += fenceMacContext(macContext);
  if (recalledMemory) {
    // H9: the recalled brain hits are ingested content — fence them as data.
    voiceSystemText +=
      `\n\nAuto-recalled from your brain (top gbrain hits for this question; excerpts are TRUNCATED):\n` +
      fenceUntrusted("brain search hits", recalledMemory) +
      `\nBefore saying you don't know, run 'gbrain get <slug>' on any hit whose slug looks relevant — especially vidi/notes/* (things ${getUserConfig().displayName} explicitly asked you to remember).`;
  }
  if (recentContext) {
    // H9: the 48h buffer is ingested notes/conversation — fence it as data.
    voiceSystemText +=
      `\n\nFrom the last 48 hours (not yet in your brain — most relevant first):\n` +
      fenceUntrusted("recent notes and conversation", recentContext);
  }
  if (sessionPreamble) {
    voiceSystemText += `\n\n${sessionPreamble}`;
  }

  // Care signals: a compact, NEUTRAL read of the shape of this sitting (local
  // lateness, how long it's run, a return after a gap, a repeated ask). Surfaced
  // as data for the model's judgment — the persona's "How you care" section
  // decides IF and HOW to react, rarely. No hardcoded triggers. Only for a plain
  // turn (a rewritten fleet/brief prompt is already grounded), computed from the
  // thread as it stands BEFORE this turn is appended, with the incoming
  // transcript passed so a retry counts the turn in flight. Fail-open.
  if (!isRewritten) {
    try {
      const careBlock = renderCareSignals(
        computeCareSignals(thread.messages, { currentUserText: transcript })
      );
      if (careBlock) voiceSystemText += `\n\n${careBlock}`;
    } catch {
      /* no signals block — default behavior */
    }
  }

  await updateThread(thread.id, (th) => {
    th.messages.push({ role: "user", text: effectiveTranscript, ts: Date.now() });
    if (opts.mode !== undefined) th.mode = normalizeMode(opts.mode);
    if (typeof opts.model === "string" && VOICE_MODELS.has(opts.model)) {
      th.model = opts.model;
    }
    if (opts.effort !== undefined) th.effort = normalizeEffort(opts.effort);
  });

  const provider = getProvider("claude")!;

  ack();

  let accumulated = "";
  let resultText: string | null = null;
  try {
    // Serialize turns on the voice thread (Mac + phone + every command share
    // it) and re-read inside the lock so this turn resumes the session id the
    // prior turn just wrote.
    await withTurnLock(thread.id, async () => {
      const fresh = getThread(thread.id) ?? thread;
      // FIX 1: drop the resume when the thread's settings no longer match the
      // session's fingerprint, so a mid-conversation model/effort switch takes
      // effect on this turn instead of being ignored.
      const current = computeFingerprint(fresh);
      const resume = shouldResumeSession({
        priorProviderSessionId: fresh.providerSessionId,
        storedFingerprint: fresh.sessionFingerprint,
        current,
      });
      const gen = provider.sendMessage({
        threadId: thread.id,
        priorProviderSessionId: resume ? fresh.providerSessionId : null,
        sessionAccountId: fresh.sessionAccountId ?? null,
        userMessage: effectiveTranscript,
        model: fresh.model,
        mode: normalizeMode(fresh.mode),
        effort: fresh.effort,
        extraSystemText: voiceSystemText,
        signal: opts.signal,
      });

      for await (const ev of gen) {
        if (ev.type === "delta") {
          accumulated += ev.text;
          try {
            opts.onDelta?.(ev.text);
          } catch {
            /* a delta-callback error must not abort the turn */
          }
        } else if (ev.type === "tool") {
          appendJournal({
            ts: Date.now(),
            threadId: thread.id,
            tool: ev.tool,
            summary: ev.summary,
          });
        } else if (ev.type === "done") {
          // Parse + strip commitment markers on the assembled result BEFORE it
          // becomes the spoken/persisted text — markers must never be spoken.
          resultText = stripCommitmentMarkers(ev.fullText || accumulated);
          await updateThread(thread.id, (th) => {
            th.providerSessionId = ev.providerSessionId ?? th.providerSessionId;
            if (ev.accountId !== undefined) th.sessionAccountId = ev.accountId;
            // FIX 1: stamp the PRE-SEND snapshot (`current`), not a recompute
            // from `th` — a settings PATCH landing after send but before this
            // done (separate withThreadLock) would otherwise get baked into the
            // fingerprint while the live session still embodies the old settings.
            th.sessionFingerprint = current;
            th.messages.push({ role: "assistant", text: resultText!, ts: Date.now() });
          });
        } else if (ev.type === "error") {
          if (ev.resetProviderSession) {
            await updateThread(thread.id, (th) => {
              th.providerSessionId = null;
            });
          }
          // Raw CLI detail goes to the log; the SPOKEN result is plain language
          // (T1.4 — a spoken stack trace would be worse than a text one).
          console.error("[voice] provider error:", ev.message);
          recordProviderDiag(ev.message); // observe-only local ledger
          resultText = plainLanguageProviderError(ev.message);
        }
      }
    });
  } catch (err: any) {
    console.error("[voice] turn threw:", err);
    recordProviderDiag(err?.message); // observe-only local ledger
    resultText = plainLanguageProviderError(err?.message);
  }

  // If the stream ended without a `done` (only deltas), still strip markers off
  // the accumulated text so a partial marker never reaches TTS.
  const finalText =
    resultText ??
    (accumulated ? stripCommitmentMarkers(accumulated) : "Something went wrong: no output.");
  return finalText;
}
