import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dataPath } from "@/lib/data-dir";
import { gatherStandingReport } from "@/lib/standing-report";
import { rememberNote } from "@/lib/brain";
import { getUserConfig } from "@/lib/user-config";
import { setQuiet } from "@/lib/quiet";
import { handsAct } from "@/lib/hands";
import { startLoop } from "@/lib/loop";
import {
  close as closeAgent,
  findByName,
  listAgents,
  listVisibleAgents,
  prompt as promptAgent,
  spawn as spawnAgent,
} from "@/lib/agents/manager";
import { addGoal, listGoals, setGoalStatus, getGoal } from "@/lib/goals";
import type { FleetIntent } from "@/lib/agents/intents";
import { pingDiscord } from "@/lib/ping-discord";
import { fenceUntrusted } from "@/lib/untrusted";

/**
 * Fleet-command handlers, split out of the voice route so BOTH the Mac SSE
 * route and the phone JSON route reach one implementation via runVoiceTurn.
 *
 * handleFleetIntent takes an ALREADY-MATCHED intent (the caller matches once so
 * it can intercept confirm/cancel/brief-me before anything else) plus the raw
 * transcript (a few handlers, e.g. sentrySummarize, need the exact words).
 *
 * Returns:
 *   - string          → a synchronous spoken reply
 *   - { rewritePrompt}→ swap the prompt and run a grounded act turn
 *   - null            → not handled; fall through to a normal Vidi turn
 *
 * Every branch is fail-soft; the caller also wraps this in a try/catch that
 * treats a throw as "fall through", so a broken fleet action never breaks the
 * frozen SSE contract.
 *
 * NOTE: confirm / cancelPending / briefMe are handled by the CALLER
 * (runVoiceTurn), never here — they must run before any other rule.
 */
export async function handleFleetIntent(
  intent: FleetIntent,
  transcript: string
): Promise<string | { rewritePrompt: string } | null> {
  // Sentry Mode ("watch this window/video") — capture runs in the menu-bar
  // app; these just relay through the Hands server and speak its replies.
  if (intent.kind === "sentryStart") {
    const r = await handsAct({
      action: "sentryStart",
      trigger: intent.trigger,
      goal: intent.goal,
      audio: intent.audio,
    });
    if (!r?.ok) return r?.error ? `I couldn't start watching: ${r.error}` : "I couldn't start watching.";
    return r.say || "Watching.";
  }
  if (intent.kind === "sentryStop") {
    const r = await handsAct({ action: "sentryStop" });
    // Persist any audio transcript for optional long-term memory ingest — the watch is
    // over, but what the video said becomes long-term memory.
    try {
      const t = await handsAct({ action: "sentryTranscript" });
      const transcriptText: string = t?.ok ? (t.transcript || "").trim() : "";
      if (transcriptText) {
        // Shared dataDir() — unset → byte-identical to <cwd>/data/sentry-transcripts.
        const dir = dataPath("sentry-transcripts");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        writeFileSync(
          path.join(dir, `${stamp}.md`),
          `# Sentry transcript — ${new Date().toISOString()}\n\n${transcriptText}\n`
        );
      }
    } catch {
      /* transcript persistence must never break the stop reply */
    }
    return r?.ok ? r.say || "Stopped watching." : "I wasn't watching anything.";
  }
  if (intent.kind === "sentryStatus") {
    const r = await handsAct({ action: "sentryStatus" });
    const s = r?.status;
    if (!r?.ok || !s) return "I can't reach my eyes right now — is the Vidi app running?";
    if (!s.watching) return "I'm not watching anything right now.";
    const looks = s.visionCallsUsed > 0 ? `, ${s.visionCallsUsed} close looks used` : "";
    const transcribing = s.transcriptChars > 0 ? `, transcribing audio` : "";
    return `Watching ${s.window} for ${s.minutes} minute${s.minutes === 1 ? "" : "s"}${looks}${transcribing}.`;
  }
  if (intent.kind === "remember") {
    try {
      rememberNote(intent.note);
      const gist = intent.note.length > 70 ? intent.note.slice(0, 67) + "…" : intent.note;
      return `Saved — I'll remember that ${gist}`;
    } catch (err: any) {
      return `I couldn't save that: ${err?.message || "write failed"}`;
    }
  }
  // Quiet mode — the manual override for the politeness engine. Persist the
  // toggle; the broker ORs isQuiet() into PolicyInputs.dndOrQuiet to suppress
  // (or resume) unprompted speech.
  if (intent.kind === "quietMode") {
    setQuiet(intent.on);
    return intent.on
      ? "Quiet mode on — I'll hold everything until you say otherwise."
      : "Quiet mode off — I'll speak up again.";
  }
  // C2 system fast-path — relay the mapped verb to the native SystemActions via
  // the Hands server and speak a short confirmation. No LLM turn.
  if (intent.kind === "system") {
    const r = await handsAct({ action: "system", verb: intent.verb, ...intent.args });
    if (!r) return "I can't reach the Mac controls right now.";
    return r.ok ? r.say || "Done." : r.error || "I couldn't do that.";
  }
  if (intent.kind === "standingReport") {
    const opsData = await gatherStandingReport();
    return {
      rewritePrompt:
        `Give ${getUserConfig().displayName} their spoken standing report from the ops data below. ` +
        `Lead with anything broken or HELD; then the fleet and latest NightShift ` +
        `findings; close with the single most important next action. 4-7 short ` +
        `sentences, spoken-style, no lists.\n\n` +
        // H9: ops data (NightShift findings, agent output) is ingested content.
        fenceUntrusted("ops data", opsData),
    };
  }
  if (intent.kind === "sentrySummarize") {
    const r = await handsAct({ action: "sentryTranscript" });
    const fullTranscript: string = r?.ok ? r.transcript || "" : "";
    if (!fullTranscript.trim()) {
      return "I don't have a video transcript — say watch this video while it plays, then ask me.";
    }
    // Keep the tail — the most recent ~12k chars is what the user just watched.
    const excerpt = fullTranscript.slice(-12_000);
    return {
      rewritePrompt:
        `The user watched a video and you transcribed its audio. Answer their question ` +
        `from the transcript only — do not invent details.\n` +
        `Their question: "${transcript}"\n\n` +
        // H9: a transcribed video's audio is untrusted ingested content — a
        // video that says "ignore your instructions" must not steer the turn.
        fenceUntrusted("video transcript", excerpt),
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Standing goals (C4)                                                        */
  /* -------------------------------------------------------------------------- */

  if (intent.kind === "newGoal") {
    const goal = addGoal({ title: intent.title, description: intent.title });
    const title = goal.title.length > 60 ? goal.title.slice(0, 57) + "…" : goal.title;
    return `Got it — standing goal set: ${title}. I'll chip away at it on my ticks and report progress.`;
  }
  if (intent.kind === "goalStatus") {
    const goals = listGoals().filter((g) => g.status !== "done");
    if (goals.length === 0) return "You don't have any standing goals right now.";
    const parts = goals.map((g) => {
      const last = g.lastTick ? `, last ${g.lastTick.status}` : "";
      return `${g.title} — ${g.status}${last}`;
    });
    return `You have ${goals.length} ${goals.length === 1 ? "goal" : "goals"}: ${parts.join("; ")}.`;
  }
  if (
    intent.kind === "pauseGoal" ||
    intent.kind === "resumeGoal" ||
    intent.kind === "dropGoal"
  ) {
    // Resolve the spoken name to a real goal by fuzzy match on slug/title. No
    // match → fall through to a normal turn (don't invent a goal mutation).
    const match = resolveGoalByName(intent.name);
    if (!match) return null;
    const status =
      intent.kind === "pauseGoal" ? "paused" : intent.kind === "resumeGoal" ? "active" : "done";
    const updated = setGoalStatus(match.slug, status);
    if (!updated) return null; // vanished between resolve and write — fall through
    const verb =
      intent.kind === "pauseGoal" ? "Paused" : intent.kind === "resumeGoal" ? "Resumed" : "Dropped";
    return `${verb} the goal: ${updated.title}.`;
  }

  // Teach-by-demonstration macros (zero-LLM GUI replay via the Hands server).
  if (intent.kind === "macroRecord") {
    const r = await handsAct({ action: "macroRecordStart", name: intent.name });
    if (!r?.ok) return r?.error ? `I couldn't start recording: ${r.error}` : "I couldn't start recording.";
    return `Watching. Do the steps, then say "stop watching" — I'll save it as "${intent.name}".`;
  }
  if (intent.kind === "macroStop") {
    const r = await handsAct({ action: "macroRecordStop" });
    if (!r?.ok) return "I wasn't recording anything.";
    return `Saved — ${r.steps ?? 0} step${r.steps === 1 ? "" : "s"}. Say "run" it any time.`;
  }
  if (intent.kind === "macroList") {
    const r = await handsAct({ action: "macroList" });
    const macros: any[] = r?.macros || [];
    if (macros.length === 0) return "I don't have any saved routines yet. Say \"watch this\" to teach me one.";
    return `I know ${macros.length}: ${macros.map((m) => m.name).join(", ")}.`;
  }
  if (intent.kind === "macroPlay") {
    const r = await handsAct({ action: "macroPlay", name: intent.name });
    // Fall through to a normal Vidi turn ONLY when the macro layer genuinely
    // can't handle it (no such macro, or Hands not configured) — so "do the
    // dishes" isn't swallowed. A transport error/timeout must NOT fall through
    // (the native replay may be running; a normal turn on top would collide).
    if (!r?.ok && /no macro|not configured/i.test(r?.error || "")) return null;
    if (!r?.ok) return `That didn't run: ${r?.error || "unknown error"}.`;
    return `Running "${intent.name}" now.`;
  }

  if (intent.kind === "spawn") {
    // "vidi, spawn a claude agent" — the user asked from the main (voice) chat.
    const agent = spawnAgent({ provider: intent.provider, name: intent.name, origin: "chat" });
    pingDiscord(`Vidi spawned agent ${agent.name} (${agent.provider})`);
    return `${agent.name}, a ${agent.provider} agent, is ready.`;
  }

  if (intent.kind === "loop") {
    // "vidi, loop until …" — a user-started loop, so its agent shows on Canvas.
    const res = startLoop({ goal: intent.goal, origin: "manual" });
    if (!res.ok) return `I couldn't start the loop: ${res.reason}.`;
    pingDiscord(`Vidi started a loop (${res.agentName}): ${intent.goal.slice(0, 100)}`);
    const goal = intent.goal.length > 60 ? intent.goal.slice(0, 57) + "…" : intent.goal;
    return `Starting a loop with ${res.agentName} to ${goal}. I'll keep iterating and you can watch on the fleet canvas.`;
  }

  if (intent.kind === "status") {
    // QA fix (PR #48 review): headline the agents the USER started (chat/manual
    // origin) — background goal/system agents must not surface as a canvas-style
    // surprise in voice either. Mention them honestly (count only, no names) when
    // there are any, rather than silently folding them into the headline count.
    const visible = listVisibleAgents();
    const backgroundCount = listAgents().length - visible.length;
    const backgroundSuffix = backgroundCount > 0 ? `, plus ${backgroundCount} background` : "";
    if (visible.length === 0) {
      return backgroundCount > 0
        ? `No agents you started are running right now${backgroundSuffix}.`
        : "No agents are running right now.";
    }
    const parts = visible.map((a) => {
      const s = a.status === "working" ? "working" : a.status === "error" ? "hit an error" : "idle";
      return `${a.name} is ${s}`;
    });
    return `You have ${visible.length} ${visible.length === 1 ? "agent" : "agents"} running${backgroundSuffix}: ${parts.join(", ")}.`;
  }

  if (intent.kind === "close") {
    const agent = findByName(intent.name);
    if (!agent) return null; // not a real agent — let normal Vidi handle it
    closeAgent(agent.id);
    return `Closed ${agent.name}.`;
  }

  if (intent.kind === "ask") {
    const agent = findByName(intent.name);
    if (!agent) return null; // unknown name → fall through to a normal turn
    const res = promptAgent(agent.id, intent.task);
    if (!res.ok) return res.reason || `${agent.name} is busy.`;
    pingDiscord(`Vidi -> ${agent.name}: ${intent.task.slice(0, 100)}`);
    const task = intent.task.length > 60 ? intent.task.slice(0, 57) + "…" : intent.task;
    return `Told ${agent.name} to ${task}. I'll keep working on it.`;
  }

  // confirm / cancelPending / briefMe are handled by the caller; anything else
  // unrecognized falls through to a normal turn.
  return null;
}

/**
 * Resolve a spoken goal name to a real goal. Exact slug first, then a fuzzy
 * contains-match on slug or title (case/space-insensitive). Ambiguous or no
 * match returns null so the caller falls through rather than mutating the wrong
 * goal.
 */
function resolveGoalByName(name: string): { slug: string; title: string } | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  // Exact slug (kebab) — the most precise handle.
  const bySlug = getGoal(needle.replace(/\s+/g, "-"));
  if (bySlug) return bySlug;

  const goals = listGoals();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const n = norm(name);
  const matches = goals.filter(
    (g) => norm(g.title).includes(n) || norm(g.slug).includes(n) || n.includes(norm(g.slug))
  );
  return matches.length === 1 ? matches[0] : null;
}
