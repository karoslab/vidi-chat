import { NextRequest } from "next/server";
import { getProvider } from "@/lib/providers";
import { classifyTaskShape, detectDelegation, extractDelegatedTask } from "@/lib/agents/delegate";
import { prompt as promptAgent, spawn as spawnAgent } from "@/lib/agents/manager";
import { appendJournal } from "@/lib/journal";
import { normalizeEffort, normalizeMode } from "@/lib/models";
import { getModelPolicy } from "@/lib/model-policy";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import { plainLanguageProviderError } from "@/lib/provider-error";
import { chatExtraSystemText } from "@/lib/chat-system-text";
import { classifyProviderCategory, recordDiag, recordProviderDiag } from "@/lib/diag-ledger";
import { markCategoryOffered, shouldOfferReport } from "@/lib/feedback";
import { type Attachment, validateAttachment } from "@/lib/attachments";
import {
  createThread,
  excerptTitle,
  getThread,
  updateThread,
  withTurnLock,
} from "@/lib/store";
import { registerTurnAbort } from "@/lib/turn-abort";
import { computeFingerprint, shouldResumeSession } from "@/lib/session-fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { threadId?, message, provider?, model?, mode?, effort? }
 * → SSE stream: {type:"meta",threadId} then {type:"delta",text} /
 *   {type:"tool",tool,summary} events, then
 *   {type:"done",fullText} | {type:"error",message}
 *   A delegated turn (explicit "spawn an agent…" or a big auto-mode ask)
 *   instead emits {type:"agentSpawned",agentId,agentName,reason} followed by
 *   a done-with-ack; the agent's answer lands on this thread later.
 * `mode` is "plan" | "auto" (legacy "chat"/"act" accepted); `effort` is
 * low | medium | high | ultra. model/mode/effort sent on an existing thread
 * update its stored settings for this and future turns.
 */
export async function POST(req: NextRequest) {
  // P8 finding 3: this route drives a write-capable act-mode agent as the user —
  // the RCE surface. A POSITIVE session/control token is required, NOT
  // sameOriginOk alone (which a raw-TCP tailnet peer forges past). The browser UI
  // attaches x-vidi-session-token via the layout fetch-shim; ops sends the
  // control token.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";

  // Attachments the user handed us. SECURITY CHOKEPOINT: every ref is
  // re-validated to a real file strictly inside data/uploads/ before its path
  // can ever reach the model — a request must never point Read at an arbitrary
  // path (keys.rtf, ~/.ssh). validateAttachment drops anything that escapes.
  const resolvedAtts = Array.isArray(body.attachments)
    ? (body.attachments
        .map(validateAttachment)
        .filter(Boolean) as { att: Attachment; abs: string }[])
    : [];
  const atts: Attachment[] = resolvedAtts.map((r) => r.att);

  // Allow an attachment-only send (a screenshot with no words); otherwise text
  // is still required so an empty POST can't create a blank turn.
  if (!message && atts.length === 0) {
    return Response.json({ error: "message required" }, { status: 400 });
  }

  // The block appended to the prompt that tells the model to Read the files.
  // Built from the VALIDATED absolute paths only. Kept separate from the
  // persisted message text so the thread stores the user's clean words.
  const attBlock = resolvedAtts.length
    ? `\n\n[The user attached these files — use your Read tool to view them for context:\n${resolvedAtts
        .map((r) => `- ${r.abs}`)
        .join("\n")}]`
    : "";

  let thread = body.threadId ? getThread(body.threadId) : null;
  if (!thread) {
    const providerId = body.provider || "claude";
    if (!getProvider(providerId)) {
      return Response.json({ error: `unknown provider: ${providerId}` }, { status: 400 });
    }
    thread = createThread(
      providerId,
      body.model ?? null,
      body.mode ? normalizeMode(body.mode) : "plan",
      body.effort ? normalizeEffort(body.effort) : undefined
    );
  }

  const provider = getProvider(thread.provider);
  if (!provider) {
    return Response.json({ error: `unknown provider: ${thread.provider}` }, { status: 400 });
  }

  // Persist the user message up front (under the thread lock — a concurrent
  // turn on the same thread must not clobber it); title on first message.
  const t = await updateThread(thread.id, (th) => {
    if (th.messages.length === 0)
      th.title = excerptTitle(message || atts[0]?.name || "Attachment");
    th.messages.push({
      role: "user",
      text: message,
      ts: Date.now(),
      ...(atts.length ? { attachments: atts } : {}),
    });
    if (body.model) th.model = body.model;
    if (body.effort) th.effort = normalizeEffort(body.effort);
    if (body.mode) th.mode = normalizeMode(body.mode);
  });
  if (!t) {
    return Response.json({ error: "thread not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  // NOT wired to the SSE stream's cancel(): a chat turn must survive client
  // disconnect (page refresh, in-app navigation, closed tab) — the turn
  // finishes server-side and persists to the thread, so the user sees the
  // reply when they reopen it. The explicit stop button (POST
  // /api/threads/[id]/stop) is the only thing that aborts this — it's
  // registered below, once the turn actually holds the lock.
  const abort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* client gone — the turn keeps running and persists to the thread */
        }
      };

      send({ type: "meta", threadId: t.id, provider: t.provider });

      // Delegation: an explicit "spawn an agent to…" or a big auto-mode ask
      // runs as a background fleet agent instead of an inline turn. The chat
      // gets an immediate ack, the client jumps to the Canvas to watch, and
      // the agent posts its answer back into THIS thread when it finishes
      // (reportBackToOrigin in the fleet manager).
      const delegationReason = detectDelegation(message, normalizeMode(t.mode));
      if (delegationReason && t.provider === "claude") {
        try {
          // Attachments ride along so a delegated agent is told to Read them
          // too (the abs paths point at the real uploads dir, not the worktree).
          const task = extractDelegatedTask(message) + attBlock;
          // Model by task shape (the owner, 2026-07-05): build-shaped work spawns
          // on the policy DEEP tier — deepModel ("auto" → the router resolves
          // opus+ultracode in act mode) at deepEffort ("high") — while
          // mechanical errands fall through to the spawn's WORKER-tier default
          // (sonnet+medium). Both tiers come from lib/model-policy.ts so the
          // install can retune them without touching this route.
          const shape = classifyTaskShape(task);
          const policy = getModelPolicy();
          const agent = spawnAgent({
            provider: "claude",
            originThreadId: t.id,
            model: shape === "build" ? policy.deepModel : undefined,
            effort: shape === "build" ? policy.deepEffort : undefined,
            // Delegated from the main chat — a user-initiated agent, so it shows
            // on the Canvas.
            origin: "chat",
          });
          const res = promptAgent(agent.id, task);
          if (!res.ok) throw new Error(res.reason || "agent unavailable");
          const ack =
            `On it. I've spun up agent **${agent.name}** to work on this in the background. ` +
            `You can watch it live on the Canvas; I'll post the answer back into this chat the moment it's done.`;
          await updateThread(t.id, (th) => {
            th.messages.push({ role: "assistant", text: ack, ts: Date.now() });
          });
          send({
            type: "agentSpawned",
            agentId: agent.id,
            agentName: agent.name,
            reason: delegationReason,
          });
          send({ type: "done", fullText: ack, threadId: t.id });
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        } catch {
          // Fleet full or spawn failed — answer inline instead; a degraded
          // answer beats an error for a question Vidi can handle herself.
        }
      }

      try {
        // Whole-turn serialization per thread: overlapping turns would both
        // --resume the same stale session and fork the CLI-side context.
        // Re-read inside the lock to pick up the prior turn's session id.
        await withTurnLock(t.id, async () => {
        const fresh = getThread(t.id) ?? t;
        // Registered only now that this turn actually holds the lock — so
        // the stop button always aborts the turn genuinely running for this
        // thread, never one still queued behind an earlier one.
        const unregisterAbort = registerTurnAbort(t.id, abort);
        try {
        // FIX 1: a CLI session is pinned to the model/agent/effort it was born
        // with. If the thread's current settings no longer match the session's
        // fingerprint (the user switched model/effort/mode/provider), drop the
        // --resume so a FRESH session picks up the switch instead of silently
        // ignoring it (or 500ing on grok).
        const current = computeFingerprint(fresh);
        const resume = shouldResumeSession({
          priorProviderSessionId: fresh.providerSessionId,
          storedFingerprint: fresh.sessionFingerprint,
          current,
        });
        const gen = provider.sendMessage({
          threadId: t.id,
          priorProviderSessionId: resume ? fresh.providerSessionId : null,
          sessionAccountId: fresh.sessionAccountId ?? null,
          // Persisted text stays clean; the model gets the Read-these-files
          // block appended. "(see attached files)" covers an image-only send.
          userMessage: (message || "(see attached files)") + attBlock,
          model: fresh.model,
          mode: normalizeMode(fresh.mode),
          effort: fresh.effort,
          // Onboarding personality tone (parity with the voice path). Undefined
          // for an existing install with no profile → prompt unchanged.
          extraSystemText: chatExtraSystemText(),
          signal: abort.signal,
        });

        for await (const ev of gen) {
          if (ev.type === "delta") {
            send(ev);
          } else if (ev.type === "tool") {
            // Journal only auto-mode actions; plan mode is read-only noise.
            if (normalizeMode(fresh.mode) === "auto") {
              appendJournal({
                ts: Date.now(),
                threadId: t.id,
                tool: ev.tool,
                summary: ev.summary,
              });
            }
            send(ev);
          } else if (ev.type === "reasoning") {
            // Honest "reasoning happened" signal (never redacted text) — forward
            // it to the client so it can show a collapsed badge on this turn.
            send(ev);
          } else if (ev.type === "done") {
            // Re-read + save under the thread lock; the in-memory `t` is
            // stale by now if another turn ran concurrently. `stopped` marks
            // a turn the stop button cut short (claude.ts/codex.ts's onAbort)
            // so the partial answer is never silently dropped.
            await updateThread(t.id, (th) => {
              th.providerSessionId = ev.providerSessionId ?? th.providerSessionId;
              // Remember which account owns this session so the next turn only
              // --resumes it on that same account (failover may have switched).
              if (ev.accountId !== undefined) th.sessionAccountId = ev.accountId;
              // FIX 1: stamp the PRE-SEND snapshot (`current`) the session was
              // actually born with — NOT a recompute from `th` here, which can
              // already reflect a settings PATCH that landed after send but
              // before this done event (separate withThreadLock race). Stamping
              // the recompute would silently adopt the new settings into the
              // fingerprint while the live session still embodies the old ones,
              // so the next turn wrongly resumes instead of switching.
              th.sessionFingerprint = current;
              th.messages.push({
                role: "assistant",
                text: ev.fullText,
                ts: Date.now(),
                ...(ev.stopped ? { stopped: true as const } : {}),
              });
            });
            send({
              type: "done",
              fullText: ev.fullText,
              threadId: t.id,
              ...(ev.stopped ? { stopped: true } : {}),
            });
          } else if (ev.type === "error") {
            if (ev.resetProviderSession) {
              await updateThread(t.id, (th) => {
                th.providerSessionId = null;
              });
            }
            // The provider's error message carries raw CLI detail — log it, but
            // hand the client a plain-language line (T1.4 error boundary).
            console.error("[chat] provider error:", ev.message);
            recordProviderDiag(ev.message); // observe-only local ledger
            // ask-on-error: after N same-category fails this session (and not
            // already offered today), invite the user to send a report. Never
            // auto-sends — the client just surfaces a gentle one-time prompt.
            const failCategory = classifyProviderCategory(ev.message);
            let offerReport = false;
            if (shouldOfferReport(failCategory)) {
              markCategoryOffered(failCategory);
              offerReport = true;
            }
            send({ type: "error", message: plainLanguageProviderError(ev.message), offerReport });
          }
        }
        } finally {
          unregisterAbort();
        }
        });
      } catch (err: any) {
        // Keep the real error (paths, stack, CLI detail) in the SERVER log; the
        // user gets a plain-language line, never a raw exception at the boundary.
        console.error("[chat] turn failed:", err);
        recordDiag("route-error", err?.message ?? String(err)); // observe-only
        send({
          type: "error",
          message: "Something went wrong on my end. Try that again in a moment.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed by cancel() */
        }
      }
    },
    cancel() {
      // Deliberately NOT aborting: the CLI turn finishes and its reply
      // persists even if the browser navigated away or refreshed mid-turn
      // (the exact "click elsewhere and the session is gone" bug).
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
