import { isKillEngaged } from "./kill.ts";
import { summarizeQuota } from "./quota.ts";
import { getThread } from "./store.ts";
import {
  abortAgentTurn,
  close as closeAgent,
  findByName,
  getAgent,
  isUserVisibleOrigin,
  prompt as promptAgent,
  pushSystemNote,
  spawn as spawnAgent,
  subscribe,
} from "./agents/manager.ts";
import type { AgentOrigin } from "./agents/manager.ts";

/**
 * Loop controller — CNVS-style "iterate until the goal is met". Runs an
 * act-mode fleet agent through bounded iterations, parsing a STATUS line each
 * turn to decide continue/done/blocked. This is the autonomous mode, so it is
 * heavily guarded (all backstops from the quota-safety research):
 *   - Sonnet only (never Opus) for autonomous runs
 *   - iteration cap (default 6, hard 12)
 *   - per-loop output-token budget
 *   - kill switch checked before every iteration
 *   - quota-aware: defers if the 5-hour window is already hot
 * Progress surfaces on the agent's fleet card (system feed notes); the loop is
 * fire-and-forget and fully observable on /canvas.
 */

const DEFAULT_MAX = 6;
const HARD_CAP = 12;
const TOKEN_BUDGET = 150_000; // cumulative output tokens across the loop
const HOT_WINDOW_OUTPUT = 400_000; // 5h output-token ceiling before deferring

export interface LoopOpts {
  goal: string;
  agentName?: string; // reuse an existing agent, else spawn one
  url?: string; // if set, the agent is told it can screenshot this URL
  maxIterations?: number;
  /** Who started this loop — stamped on a freshly spawned loop agent. A
   *  user-started loop ("vidi, loop …" / a Canvas Loop) is "manual" and shows on
   *  the Canvas; a standing-goal tick passes "goal" so its agent is background —
   *  hidden from the Canvas AND torn down when the loop ends (no accumulation).
   *  Defaults to "manual". */
  origin?: AgentOrigin;
  // Fired once when the loop reaches a terminal state, so a caller (the goals
  // tick) can react to the outcome without polling the fleet. "done"/"blocked"
  // mirror the parsed STATUS; "cap" means the iteration cap was hit with no
  // DONE. Errors/timeouts/kill/quota are internal stops and don't fire this —
  // the goals tick treats a missing onFinish as "no progress this tick".
  onFinish?: (status: "done" | "blocked" | "cap") => void;
}

export interface LoopStart {
  ok: boolean;
  reason?: string;
  loopId?: string;
  agentName?: string;
}

interface Status {
  kind: "done" | "continue" | "blocked" | "unknown";
  note: string;
}

function loopPrompt(opts: LoopOpts, iter: number, max: number): string {
  const lines = [
    `You are running in an autonomous LOOP toward this goal:`,
    `  ${opts.goal}`,
    ``,
    `This is iteration ${iter} of at most ${max}. Make concrete, verifiable progress this iteration — don't just plan.`,
  ];
  if (opts.url) {
    lines.push(
      `You can see the running app: run \`node scripts/snap.mjs ${opts.url} data/loops/shot.png\` then Read data/loops/shot.png to inspect the result before judging.`
    );
  }
  lines.push(
    ``,
    `End your message with EXACTLY ONE status line, nothing after it:`,
    `  STATUS: DONE — <what you accomplished>       (only if the goal is fully met and verified)`,
    `  STATUS: CONTINUE — <the single next step>    (more work remains)`,
    `  STATUS: BLOCKED — <what you need from the owner> (cannot proceed safely)`
  );
  return lines.join("\n");
}

function parseStatus(text: string): Status {
  // Only a LINE that STARTS with "STATUS:" counts (the agent is told to end
  // with exactly one). Last such line wins, and we take the FIRST keyword on
  // it — so trailing prose like "...this becomes STATUS: DONE" inside a
  // CONTINUE line can't cause a false DONE / premature termination.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*STATUS:\s*(DONE|CONTINUE|BLOCKED)\b\s*[—:-]?\s*(.*)/i);
    if (m) {
      return {
        kind: m[1].toLowerCase() as "done" | "continue" | "blocked",
        note: (m[2] || "").trim().slice(0, 200),
      };
    }
  }
  return { kind: "unknown", note: "" };
}

function lastAssistantText(agentId: string): string {
  const t = getThread(agentId);
  if (!t) return "";
  for (let i = t.messages.length - 1; i >= 0; i--) {
    if (t.messages[i].role === "assistant") return t.messages[i].text;
  }
  return "";
}

/** Resolve once the agent leaves "working" (idle/error), is closed, or times
 *  out. Reacting to close() too means a mid-turn close ends the loop promptly
 *  instead of stalling for the full timeout. */
function waitForTurn(agentId: string, timeoutMs = 600_000): Promise<"idle" | "error" | "closed" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: "idle" | "error" | "closed" | "timeout") => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve(r);
    };
    const unsub = subscribe((e) => {
      if (e.kind === "close" && e.agent.id === agentId) return finish("closed");
      if (e.kind === "update" && e.agent.id === agentId && e.agent.status !== "working") {
        finish(e.agent.status === "error" ? "error" : "idle");
      }
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    // Belt-and-suspenders: if the turn already finished before we subscribed.
    const current = getAgent(agentId);
    if (!current) finish("closed");
    else if (current.status !== "working") finish(current.status === "error" ? "error" : "idle");
  });
}

/** True when the rolling 5h output-token window is already hot enough that
 *  starting more autonomous work would risk the Max quota. Exported so the
 *  goals tick can defer with the SAME threshold the loop itself uses (one
 *  source of truth — don't duplicate the window logic). */
export function quotaHot(): boolean {
  try {
    return summarizeQuota().last5h.outputTokens > HOT_WINDOW_OUTPUT;
  } catch {
    return false;
  }
}

// Agents with a loop currently running — prevents two loops interleaving turns
// on one agent (double token spend + cross-talk on the parsed status).
const activeLoops: Set<string> = ((globalThis as Record<string, any>).__vidiActiveLoops ??=
  new Set());

export function startLoop(opts: LoopOpts): LoopStart {
  if (!opts.goal?.trim()) return { ok: false, reason: "goal required" };
  if (isKillEngaged()) return { ok: false, reason: "kill switch is engaged" };
  if (quotaHot()) return { ok: false, reason: "Claude usage window is hot right now — try later" };

  const max = Math.min(opts.maxIterations || DEFAULT_MAX, HARD_CAP);
  const origin: AgentOrigin = opts.origin ?? "manual";

  // Reuse a named agent or spawn a fresh Sonnet act agent for the loop.
  let agent = opts.agentName ? findByName(opts.agentName) : null;
  if (agent && agent.model !== "sonnet") {
    // Autonomous loops are Sonnet-only by policy; refuse to loop on Opus.
    return { ok: false, reason: "loops run on Sonnet only; use a Sonnet agent" };
  }
  if (agent && activeLoops.has(agent.id)) {
    return { ok: false, reason: `${agent.name} is already running a loop` };
  }
  // A freshly spawned loop agent is disposable when the loop's origin is
  // background: tear it down at loop end so a repeating goal tick never grows
  // the roster. A reused named agent (the user's own) is left alone.
  let spawnedForLoop = false;
  if (!agent) {
    try {
      agent = spawnAgent({ provider: "claude", model: "sonnet", mode: "act", name: opts.agentName, origin });
      spawnedForLoop = true;
    } catch (e: any) {
      return { ok: false, reason: e?.message || "could not spawn a loop agent" };
    }
  }

  const loopId = `loop-${agent.id.slice(0, 8)}`;
  const agentId = agent.id;
  const disposeAtEnd = spawnedForLoop && !isUserVisibleOrigin(origin);
  activeLoops.add(agentId);
  void runLoop(agentId, agent.name, opts, max, loopId).finally(() => {
    activeLoops.delete(agentId);
    // Background loop agents don't linger as idle 0-turn cards after their run
    // (item 3); close() also drops them from the (already-filtered) registry.
    if (disposeAtEnd) closeAgent(agentId);
  });
  return { ok: true, loopId, agentName: agent.name };
}

async function runLoop(
  agentId: string,
  agentName: string,
  opts: LoopOpts,
  max: number,
  loopId: string
) {
  pushSystemNote(agentId, `▶ loop started: ${opts.goal} (max ${max} iterations)`);
  const startTokens = getAgent(agentId)?.tokens.output ?? 0;

  for (let iter = 1; iter <= max; iter++) {
    if (isKillEngaged()) {
      pushSystemNote(agentId, "■ loop stopped: kill switch engaged");
      return;
    }
    if (quotaHot()) {
      pushSystemNote(agentId, "■ loop paused: usage window hot — resume later");
      return;
    }
    const spent = (getAgent(agentId)?.tokens.output ?? 0) - startTokens;
    if (spent > TOKEN_BUDGET) {
      pushSystemNote(agentId, `■ loop stopped: token budget reached (${spent} out)`);
      return;
    }

    pushSystemNote(agentId, `↻ iteration ${iter}/${max}`);
    const res = promptAgent(agentId, loopPrompt(opts, iter, max));
    if (!res.ok) {
      // Agent busy from an external prompt — wait a beat and retry the slot.
      pushSystemNote(agentId, `⏳ ${res.reason}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const outcome = await waitForTurn(agentId);
    if (outcome === "closed") {
      // Agent was closed mid-turn (user or kill path) — stop quietly.
      return;
    }
    if (outcome === "error") {
      pushSystemNote(agentId, "■ loop stopped: iteration errored");
      return;
    }
    if (outcome === "timeout") {
      // Don't leave the turn running unsupervised past the loop's guards —
      // abort it (SIGKILLs the CLI) before exiting.
      abortAgentTurn(agentId);
      pushSystemNote(agentId, "■ loop stopped: iteration timed out (turn aborted)");
      return;
    }

    const status = parseStatus(lastAssistantText(agentId));
    if (status.kind === "done") {
      pushSystemNote(agentId, `✓ loop DONE: ${status.note}`);
      safeFinish(opts, "done");
      return;
    }
    if (status.kind === "blocked") {
      pushSystemNote(agentId, `⚠ loop BLOCKED: ${status.note}`);
      safeFinish(opts, "blocked");
      return;
    }
    // continue / unknown → next iteration
  }
  pushSystemNote(agentId, `■ loop stopped: reached ${max}-iteration cap without DONE`);
  safeFinish(opts, "cap");
}

// onFinish is caller-supplied — never let it throw into the loop's async tail.
function safeFinish(opts: LoopOpts, status: "done" | "blocked" | "cap") {
  try {
    opts.onFinish?.(status);
  } catch {
    /* a bad callback must not crash the loop */
  }
}

// Exported for unit testing the parser.
export const _internal = { parseStatus };
