import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

import { isKillEngaged as realIsKillEngaged } from "./kill.ts";
import { quotaHot as realQuotaHot, startLoop as realStartLoop } from "./loop.ts";
import type { LoopOpts } from "./loop.ts";
import { workspacePath } from "./workspace.ts";
import { getUserConfig } from "./user-config.ts";
import { dataDir as sharedDataDir } from "./data-dir.ts";

/**
 * Standing goals — long-horizon autonomy (Workstream C4).
 *
 * A goal the owner states once ("keep the ops dashboard green", "get demo-app
 * to 90% test coverage") is pursued across DAYS by a scheduled tick, not a
 * single loop. Each tick runs ONE bounded loop iteration-set per active goal,
 * then — this is the load-bearing part, borrowed from NightShift — only claims
 * progress if a deterministic verifyCmd exits 0. A loop that SAYS "DONE" but
 * whose verify fails is recorded as "blocked", never "done": the model doesn't
 * get to grade its own homework.
 *
 * Everything here fails open. This runs off a launchd curl into a control-token
 * route, far from any voice turn, but the ledger writes, the brain mirror,
 * and the verify runner all swallow their own errors so one bad goal can't
 * wedge the tick or throw into whatever called it.
 */

export interface GoalCheckpoint {
  desc: string;
  // A human confirmation gate — the tick will not auto-mark the goal done past
  // a checkpoint that still requires confirmation. the owner clears these.
  requiresConfirm: boolean;
}

export interface GoalPlan {
  /** Where the working plan markdown lives (data/goals/<slug>/plan.md). */
  path: string;
  /** When the plan was last (re)generated, epoch ms. */
  refreshedAt: number;
  /**
   * A cheap signature of the confirmed-checkpoint set at plan time. When
   * the owner clears a checkpoint (its requiresConfirm flips false) this changes,
   * which is how we detect "a checkpoint was just confirmed" and re-plan on the
   * next tick without a separate event stream.
   */
  checkpointSig?: string;
}

export interface GoalTick {
  ts: number;
  status: "done" | "blocked" | "progress" | "skipped";
  note: string;
  evidence?: string;
}

export interface GoalBudget {
  maxIterations: number; // per-loop iteration cap handed to startLoop
  maxTicksPerDay: number; // how many ticks this goal may consume in a day
}

export interface Goal {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: "active" | "paused" | "blocked" | "done";
  plan?: GoalPlan;
  checkpoints?: GoalCheckpoint[];
  lastTick?: GoalTick;
  budget: GoalBudget;
  verifyCmd?: string;
  /**
   * Re-arm cadence (hours). A "done" goal is not a terminal dead-end: once its
   * last successful verify is older than this many hours, the tick quietly
   * re-runs verifyCmd (NO loop, NO LLM spend, NOT counted against
   * maxTicksPerDay). A still-passing verify just refreshes lastVerify; a failing
   * one flips the goal back to "active" so the ordinary loop works it again.
   * Unset → the goal stays terminal once done (legacy behavior).
   */
  rearmAfterHours?: number;
  /**
   * Epoch ms of the most recent verify that PASSED (code 0), whether from a full
   * loop-DONE tick or a quiet re-arm re-verify. The clock the re-arm cadence
   * counts from. Undefined until the goal's verify has passed at least once.
   */
  lastVerify?: number;
  createdAt: number;
  updatedAt: number;
}

// Resolved lazily on every call (never cached at import) via the shared
// dataDir() (VIDI_DATA_DIR override, else <cwd>/data) so tests chdir a temp dir
// and a fresh install points at the temp dir. Unset → byte-identical to
// <cwd>/data. Caching at module load would bind to the import-time cwd.
function dataDir(): string {
  return sharedDataDir();
}
function goalsFile(): string {
  return path.join(dataDir(), "goals.json");
}
function eventsFile(): string {
  return path.join(dataDir(), "goal-events.jsonl");
}
/** Per-goal working directory; the plan markdown lives at <dir>/plan.md. */
function goalDir(slug: string): string {
  return path.join(dataDir(), "goals", slug);
}
function planPath(slug: string): string {
  return path.join(goalDir(slug), "plan.md");
}
// Human/gbrain-visible mirror. Absolute on purpose — the brain dir is the brain root,
// outside this repo's data/; the tick runs as the owner on the same box.
const BRAIN_MIRROR = workspacePath(getUserConfig().brainDirName, "vidi", "goals.md");

// The repo the verify command runs in. Vidi's own repo is the sensible default:
// most goals about workspace projects run their verify from the workspace root and cd in.
const DEFAULT_VERIFY_CWD = process.cwd();

const DEFAULT_BUDGET: GoalBudget = { maxIterations: 4, maxTicksPerDay: 3 };
// At most two goals get a loop per tick, so a single scheduled run can never
// fan out into an unbounded pile of concurrent agents.
const MAX_ACTIVE_PER_TICK = 2;
// A plan older than this is stale and gets one refresh turn on the next tick.
// Checkpoint confirmations also invalidate it (see planStale) so the plan
// reflects the newly unblocked path.
const PLAN_STALE_MS = 48 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Ledger read/write                                                          */
/* -------------------------------------------------------------------------- */

function readGoalsRaw(): Goal[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(goalsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing/corrupt file → empty ledger, not a crash.
    return [];
  }
}

function writeGoals(goals: Goal[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = goalsFile();
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(goals, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* a failed persist must not throw; the in-memory result still returns */
  }
  // Mirror to the brain on every mutation for human/gbrain visibility.
  mirrorToBrain(goals);
}

function mirrorToBrain(goals: Goal[]): void {
  try {
    const lines = [
      "# Vidi standing goals",
      "",
      `_Mirrored from vidi-chat/data/goals.json at ${new Date().toISOString()}. Do not edit by hand._`,
      "",
    ];
    if (!goals.length) {
      lines.push("_(no goals)_");
    }
    for (const g of goals) {
      lines.push(`## ${g.title} — \`${g.slug}\` (${g.status})`);
      lines.push("");
      if (g.description) lines.push(g.description, "");
      if (g.verifyCmd) lines.push(`- verify: \`${g.verifyCmd}\``);
      lines.push(
        `- budget: ${g.budget.maxIterations} iters/loop, ${g.budget.maxTicksPerDay} ticks/day`
      );
      if (typeof g.rearmAfterHours === "number") {
        const lv = g.lastVerify ? new Date(g.lastVerify).toISOString() : "never";
        lines.push(`- re-arm: every ${g.rearmAfterHours}h (last verify: ${lv})`);
      }
      if (g.checkpoints?.length) {
        lines.push("- checkpoints:");
        for (const c of g.checkpoints) {
          lines.push(`  - ${c.requiresConfirm ? "[needs confirm]" : "[auto]"} ${c.desc}`);
        }
      }
      if (g.lastTick) {
        const t = new Date(g.lastTick.ts).toISOString();
        lines.push(`- last tick (${t}): **${g.lastTick.status}** — ${g.lastTick.note}`);
        if (g.lastTick.evidence) {
          lines.push("", "```", g.lastTick.evidence.slice(0, 2000), "```");
        }
      }
      lines.push("");
    }
    fs.mkdirSync(path.dirname(BRAIN_MIRROR), { recursive: true });
    fs.writeFileSync(BRAIN_MIRROR, lines.join("\n"));
  } catch {
    /* fail-open: the brain mirror being unwritable must never break a mutation */
  }
}

function appendEvent(ev: {
  ts: number;
  goalId: string;
  slug: string;
  status: string;
  note: string;
  evidence?: string;
}): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(eventsFile(), JSON.stringify(ev) + "\n");
  } catch {
    /* the append is best-effort telemetry, never a hard dependency */
  }
}

/* -------------------------------------------------------------------------- */
/* Public ledger API                                                          */
/* -------------------------------------------------------------------------- */

export function listGoals(): Goal[] {
  return readGoalsRaw();
}

export function getGoal(slug: string): Goal | null {
  return readGoalsRaw().find((g) => g.slug === slug) ?? null;
}

/** Kebab-case a title into a slug; strip anything that isn't a word char. */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "goal";
}

export function addGoal(input: {
  title: string;
  description?: string;
  verifyCmd?: string;
  checkpoints?: GoalCheckpoint[];
}): Goal {
  const title = (input.title || "").trim();
  const goals = readGoalsRaw();

  // Dedupe on slug: re-adding the same title returns the existing goal rather
  // than creating a duplicate the tick would then double-run.
  let slug = slugify(title);
  const existing = goals.find((g) => g.slug === slug);
  if (existing) return existing;

  const now = Date.now();
  const goal: Goal = {
    id: `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    slug,
    title: title || "untitled goal",
    description: (input.description || "").trim(),
    status: "active",
    checkpoints: input.checkpoints,
    budget: { ...DEFAULT_BUDGET },
    verifyCmd: input.verifyCmd?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  goals.push(goal);
  writeGoals(goals);
  return goal;
}

export function setGoalStatus(slug: string, status: Goal["status"]): Goal | null {
  const goals = readGoalsRaw();
  const goal = goals.find((g) => g.slug === slug);
  if (!goal) return null;
  goal.status = status;
  goal.updatedAt = Date.now();
  writeGoals(goals);
  return goal;
}

/* -------------------------------------------------------------------------- */
/* Tick orchestration                                                         */
/* -------------------------------------------------------------------------- */

export interface VerifyResult {
  code: number; // process exit code (0 = pass)
  output: string; // combined stdout+stderr, truncated
}

/**
 * Injectable dependencies. Tests pass fakes so no real agent is ever spawned
 * and no real command ever runs. `runLoop` resolves to the loop's terminal
 * status; the default adapter wraps the real fire-and-forget startLoop and
 * resolves via its onFinish callback (or "error" if the loop refused to start).
 */
export interface TickDeps {
  isKillEngaged: () => boolean;
  quotaHot: () => boolean;
  runLoop: (opts: LoopOpts) => Promise<"done" | "blocked" | "cap" | "error">;
  verify: (cmd: string, cwd: string) => Promise<VerifyResult>;
  /**
   * Run ONE plan-mode turn for a goal and resolve to the plan markdown. Plan
   * mode routes to fable (models.ts resolveRun), degrading to opus+ultracode
   * when fable is quota-limited — the router owns that fallback, this dep just
   * asks for a plan turn. Returns null on any failure (the tick then keeps the
   * old plan and proceeds to the loop — planning is best-effort grounding).
   */
  runPlan: (goal: Goal) => Promise<string | null>;
  now: () => number;
}

function defaultRunLoop(opts: LoopOpts): Promise<"done" | "blocked" | "cap" | "error"> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: "done" | "blocked" | "cap" | "error") => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const started = realStartLoop({ ...opts, onFinish: (status) => done(status) });
    if (!started.ok) done("error");
    // If the loop stops on an internal guard (kill/quota/error/timeout) it never
    // fires onFinish; a generous ceiling resolves the tick as "error" so one
    // stuck goal can't hang the whole sequential sweep forever.
    setTimeout(() => done("error"), 20 * 60_000).unref?.();
  });
}

function defaultVerify(cmd: string, cwd: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    // Run through a shell so verifyCmd can be a normal command line ("cd x &&
    // npm test"). Bounded and output-capped — a verify that hangs or floods
    // must not wedge the tick.
    execFile(
      "/bin/bash",
      ["-c", cmd],
      { cwd, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim().slice(0, 4000);
        // execFile's error carries the real exit code; default to 1 on any
        // failure (signal/timeout) so a non-clean exit never counts as pass.
        const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
        resolve({ code, output });
      }
    );
  });
}

/** The prompt handed to the plan-mode turn. Plan mode is read-only research +
 *  planning, so we ask for a concrete, verifiable working plan the loop then
 *  grounds on. Kept template-simple: the model does the reasoning, we frame it. */
function planPrompt(goal: Goal): string {
  const parts = [
    `Produce a concrete WORKING PLAN for this standing goal. This plan will be read by an autonomous loop agent on future ticks, so make it a numbered, verifiable sequence of steps — not prose. State the current situation briefly, then the ordered steps, then how "done" is proven.`,
    ``,
    `GOAL: ${goal.title}`,
  ];
  if (goal.description) parts.push(`DETAILS: ${goal.description}`);
  if (goal.verifyCmd) {
    parts.push(`DONE is proven only when this command exits 0: \`${goal.verifyCmd}\`.`);
  }
  const pending = (goal.checkpoints || []).filter((c) => c.requiresConfirm);
  if (pending.length) {
    parts.push(
      `These checkpoints still need the owner's confirmation — the plan must PAUSE at them, never proceed autonomously past them: ${pending
        .map((c) => c.desc)
        .join("; ")}.`
    );
  }
  parts.push(`Output ONLY the plan markdown — no preamble, no sign-off.`);
  return parts.join("\n");
}

/**
 * Default plan adapter: run one headless plan-mode turn on the goal's own
 * persistent thread (created lazily, titled `goal:<slug>`), collect the
 * assistant's full text. model="auto" + mode="plan" makes resolveRun route to
 * fable with the opus fallback baked in, so a fable-quota day degrades cleanly
 * to opus+ultracode without any change here. Fail-open: any error → null, and
 * the tick keeps whatever plan it had.
 */
async function defaultRunPlan(goal: Goal): Promise<string | null> {
  try {
    // Lazy imports keep goals.ts loadable in unit tests without the provider
    // chain (mirrors loop.ts / manager.ts). Tests inject runPlan and never hit
    // this path, so no real CLI is ever spawned under test.
    const { getProvider } = await import("./providers/index.ts");
    const store = await import("./store.ts");
    const provider = getProvider("claude");
    if (!provider) return null;

    // Reuse the goal's persistent thread (titled `goal:<slug>`) or create it.
    const title = `goal:${goal.slug}`;
    const existing = store
      .listThreads()
      .find((m) => m.title === title && m.provider === "claude");
    let thread = existing ? store.getThread(existing.id) : null;
    if (!thread) {
      thread = store.createThread("claude", "opus", "plan");
      thread.title = title;
      store.saveThread(thread);
    }

    let full = "";
    let resultText: string | null = null;
    await store.withTurnLock(thread.id, async () => {
      const fresh = store.getThread(thread.id) ?? thread;
      const { computeFingerprint, shouldResumeSession } = await import(
        "./session-fingerprint.ts"
      );
      // FIX 1 (uniform): this loop-plan thread pins model/mode, so the
      // fingerprint stays constant and it resumes as before — but the gate is
      // applied everywhere a session is fed so the switch behavior is uniform.
      const currentFp = computeFingerprint(fresh);
      const resumeGoals = shouldResumeSession({
        priorProviderSessionId: fresh.providerSessionId ?? null,
        storedFingerprint: fresh.sessionFingerprint,
        current: currentFp,
      });
      const gen = provider.sendMessage({
        threadId: thread.id,
        priorProviderSessionId: resumeGoals ? fresh.providerSessionId ?? null : null,
        sessionAccountId: fresh.sessionAccountId ?? null,
        userMessage: planPrompt(goal),
        model: "opus", // unattended PLANNING tick — the deep tier per token-discipline policy (planning = opus at high effort); pinned off the auto router so a standing goal always drafts at planning depth
        mode: "plan",
        effort: "high", // planning/review runs at "high" (lib/models.ts DEEP_DEFAULT_EFFORT); explicit here since this pins the model directly and bypasses the auto router's tier default

        extraSystemText:
          "You are drafting a standing-goal working plan that a loop agent will follow. Be concrete and terse.",
      });
      for await (const ev of gen) {
        if (ev.type === "delta") full += ev.text;
        else if (ev.type === "done") {
          resultText = (ev.fullText || full).trim();
          await store.updateThread(thread.id, (th) => {
            th.providerSessionId = ev.providerSessionId ?? th.providerSessionId;
            if (ev.accountId !== undefined) th.sessionAccountId = ev.accountId;
            // FIX 1: stamp the PRE-SEND snapshot (`currentFp`), not a recompute
            // from `th` — a settings PATCH landing after send but before this
            // done (separate withThreadLock) would otherwise get baked into the
            // fingerprint while the live session still embodies the old settings.
            th.sessionFingerprint = currentFp;
            th.messages.push({ role: "user", text: planPrompt(goal), ts: Date.now() });
            th.messages.push({ role: "assistant", text: resultText!, ts: Date.now() });
          });
        } else if (ev.type === "error") {
          if (ev.resetProviderSession) {
            await store.updateThread(thread.id, (th) => {
              th.providerSessionId = null;
            });
          }
          resultText = null;
        }
      }
    });
    const out = resultText ?? (full.trim() || null);
    return out && out.length ? out : null;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: TickDeps = {
  isKillEngaged: realIsKillEngaged,
  quotaHot: realQuotaHot,
  runLoop: defaultRunLoop,
  verify: defaultVerify,
  runPlan: defaultRunPlan,
  now: Date.now,
};

/** How many ticks this goal has already consumed today (local calendar day). */
function ticksToday(slug: string, nowMs: number): number {
  let count = 0;
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile(), "utf8");
  } catch {
    return 0;
  }
  const now = new Date(nowMs);
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.slug !== slug || typeof ev.ts !== "number") continue;
    // Only real loop runs count against the daily budget. "skipped" (budget
    // already spent), plus the quiet re-arm outcomes "rearmed"/"reactivated"
    // (deterministic verify only — no loop, no LLM spend), are all excluded.
    if (ev.status === "skipped" || ev.status === "rearmed" || ev.status === "reactivated") continue;
    const d = new Date(ev.ts);
    if (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    ) {
      count++;
    }
  }
  return count;
}

/** Build the loop goal prompt for one goal, grounded in its plan if present. */
function goalPrompt(goal: Goal): string {
  const parts = [goal.title];
  if (goal.description) parts.push(goal.description);
  if (goal.plan?.path) {
    parts.push(`Your working plan is at ${goal.plan.path} — read it, follow it, and update it as you make progress.`);
  }
  if (goal.verifyCmd) {
    parts.push(
      `Progress is only accepted when this command exits 0: \`${goal.verifyCmd}\`. Do not claim DONE until it would pass.`
    );
  }
  const pending = (goal.checkpoints || []).filter((c) => c.requiresConfirm);
  if (pending.length) {
    parts.push(
      `These checkpoints still need the owner's confirmation — do NOT proceed past them autonomously: ${pending
        .map((c) => c.desc)
        .join("; ")}.`
    );
  }
  return parts.join("\n\n");
}

/** True if any checkpoint still gates autonomous completion. */
function hasPendingCheckpoint(goal: Goal): boolean {
  return (goal.checkpoints || []).some((c) => c.requiresConfirm);
}

/**
 * A stable signature of the goal's checkpoint-confirmation state. Flips whenever
 * a checkpoint's requiresConfirm changes (the owner confirms one), which is what
 * lets planStale detect "a checkpoint was just confirmed" without a side event
 * stream. Empty string when there are no checkpoints.
 */
function checkpointSig(goal: Goal): string {
  return (goal.checkpoints || []).map((c) => (c.requiresConfirm ? "1" : "0")).join("");
}

/**
 * Should this goal get a plan turn this tick? True when:
 *   - it has no plan yet (missing), OR
 *   - the plan file on disk is gone (mirror drifted), OR
 *   - the plan is older than PLAN_STALE_MS, OR
 *   - a checkpoint was confirmed since the plan was written (sig changed).
 * Pure and cheap so it's unit-testable; the disk check is the only I/O and it
 * fails toward "stale" (re-plan) rather than skipping.
 */
function planStale(goal: Goal, nowMs: number): boolean {
  const plan = goal.plan;
  if (!plan?.path) return true;
  try {
    if (!fs.existsSync(plan.path)) return true;
  } catch {
    return true;
  }
  if (nowMs - plan.refreshedAt > PLAN_STALE_MS) return true;
  if (plan.checkpointSig !== undefined && plan.checkpointSig !== checkpointSig(goal)) {
    return true;
  }
  return false;
}

/** Persist the plan markdown to data/goals/<slug>/plan.md. Fail-open — a plan
 *  we can't write just means the loop grounds on the goal text this tick. */
function writePlanFile(slug: string, markdown: string): boolean {
  try {
    fs.mkdirSync(goalDir(slug), { recursive: true });
    const p = planPath(slug);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, markdown);
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * If the goal's plan is missing/stale, run ONE plan turn and persist it. Mutates
 * `goal.plan` in place and returns true when a plan was (re)written this tick so
 * the caller persists the ledger. At most one plan turn per goal per tick (this
 * runs once, before the loop). Fully fail-open: a null plan result or a write
 * failure leaves the prior plan untouched and the tick proceeds to the loop.
 */
async function maybeRefreshPlan(goal: Goal, d: TickDeps, nowMs: number): Promise<boolean> {
  if (!planStale(goal, nowMs)) return false;
  let markdown: string | null = null;
  try {
    markdown = await d.runPlan(goal);
  } catch {
    markdown = null;
  }
  if (!markdown || !markdown.trim()) return false;
  if (!writePlanFile(goal.slug, markdown.trim())) return false;
  goal.plan = {
    path: planPath(goal.slug),
    refreshedAt: nowMs,
    checkpointSig: checkpointSig(goal),
  };
  return true;
}

export interface TickGoalResult {
  slug: string;
  // "rearmed" = a quiet re-verify still passed (no loop, no LLM, no budget);
  // "reactivated" = a stale re-verify failed and the goal flipped back to active.
  status: GoalTick["status"] | "rearmed" | "reactivated";
  note: string;
  evidence?: string;
}

/**
 * Is this a "done" goal whose re-arm cadence has elapsed and so is due for a
 * quiet re-verify this tick? Pure: no verify is run here. A goal with no
 * rearmAfterHours stays terminal (returns false). A done goal that has never
 * recorded a lastVerify (imported/legacy) is treated as immediately due — its
 * verify state is unknown, so re-check rather than trust a stale "done".
 */
function rearmDue(goal: Goal, nowMs: number): boolean {
  if (goal.status !== "done") return false;
  const hours = goal.rearmAfterHours;
  if (typeof hours !== "number" || hours <= 0) return false;
  const last = goal.lastVerify;
  if (typeof last !== "number") return true;
  return nowMs - last > hours * 60 * 60 * 1000;
}

/**
 * The re-arm pass: for each due "done" goal, quietly re-run verifyCmd. This is
 * the load-bearing lifecycle fix — a done goal is not a dead-end.
 *
 *   - verify passes  → refresh lastVerify, goal STAYS done. No loop, no LLM
 *     spend, and the event is logged with status "rearmed" (excluded from the
 *     daily tick budget, exactly like "skipped").
 *   - verify fails   → goal flips back to "active" so the ordinary active pass
 *     (this same tick or the next) runs the loop to repair it.
 *   - no verifyCmd   → nothing deterministic to re-check; refresh the clock so
 *     it stops re-arming every tick, and stay done.
 *
 * Runs each due goal in sequence, re-reading + persisting per goal so it never
 * clobbers a concurrent write. Fail-open throughout.
 */
async function rearmPass(
  goals: Goal[],
  d: TickDeps,
  nowMs: number,
  results: TickGoalResult[]
): Promise<void> {
  const due = goals.filter((g) => rearmDue(g, nowMs));
  for (const goal of due) {
    let r: TickGoalResult;
    let newStatus: Goal["status"] = "done";
    if (!goal.verifyCmd) {
      // Nothing to deterministically re-verify; refresh the clock and stay done.
      r = { slug: goal.slug, status: "rearmed", note: "re-arm cadence elapsed; no verifyCmd to re-check — clock refreshed" };
    } else {
      let vr: VerifyResult;
      try {
        vr = await d.verify(goal.verifyCmd, DEFAULT_VERIFY_CWD);
      } catch {
        vr = { code: 1, output: "verify threw" };
      }
      if (vr.code === 0) {
        r = { slug: goal.slug, status: "rearmed", note: "re-verify passed — still done (no LLM spent)", evidence: vr.output };
      } else {
        newStatus = "active";
        r = {
          slug: goal.slug,
          status: "reactivated",
          note: `re-verify exited ${vr.code} — re-armed to active for the loop to repair`,
          evidence: vr.output,
        };
      }
    }

    // Persist per-goal: refresh lastVerify only when we stayed done (verify
    // passed or nothing to check); on reactivation lastVerify is intentionally
    // left stale so the record shows when it last actually passed.
    const fresh = readGoalsRaw();
    const target = fresh.find((g) => g.id === goal.id);
    if (target) {
      target.updatedAt = nowMs;
      target.status = newStatus;
      if (newStatus === "done") target.lastVerify = nowMs;
      writeGoals(fresh);
    }

    appendEvent({ ts: nowMs, goalId: goal.id, slug: goal.slug, status: r.status, note: r.note, evidence: r.evidence });
    results.push(r);
    // Mutate the in-memory goal too so the active pass below sees the flip
    // (a reactivated goal becomes eligible for a loop this very tick).
    goal.status = newStatus;
    if (newStatus === "done") goal.lastVerify = nowMs;
  }
}

/**
 * Run one scheduled sweep. Sequential (never parallel — bounds token spend and
 * keeps the loop's Sonnet-only autonomy guarantees intact), at most two active
 * goals per tick, each within its own maxTicksPerDay. Defers wholesale if the
 * kill switch is engaged or the usage window is hot.
 */
export async function tickGoals(
  deps?: Partial<TickDeps>
): Promise<{ ran: boolean; results: TickGoalResult[] }> {
  const d: TickDeps = { ...DEFAULT_DEPS, ...deps };
  const nowMs = d.now();

  // Global deferrals — same backstops the loop itself honors, checked once up
  // front so a hot window or engaged kill skips the whole sweep cheaply.
  if (d.isKillEngaged()) {
    return { ran: false, results: [] };
  }
  if (d.quotaHot()) {
    return { ran: false, results: [] };
  }

  const goals = readGoalsRaw();
  const results: TickGoalResult[] = [];

  // RE-ARM PASS (quiet, no loop, no LLM, not budget-charged). Runs first so a
  // done goal whose verify has gone stale is re-checked; a failing re-verify
  // flips it back to active and the active pass below picks it up this tick.
  await rearmPass(goals, d, nowMs, results);

  const active = goals.filter((g) => g.status === "active").slice(0, MAX_ACTIVE_PER_TICK);

  for (const goal of active) {
    // Respect the per-goal daily budget.
    if (ticksToday(goal.slug, nowMs) >= goal.budget.maxTicksPerDay) {
      const r: TickGoalResult = {
        slug: goal.slug,
        status: "skipped",
        note: "daily tick budget reached",
      };
      results.push(r);
      appendEvent({ ts: nowMs, goalId: goal.id, ...r });
      continue;
    }

    // PLAN PHASE — at most one plan turn per goal per tick, BEFORE the loop, so
    // the loop grounds on a fresh plan. Missing/stale (>48h) or a just-confirmed
    // checkpoint triggers it; a plan-turn failure is non-fatal (keep the old
    // plan and proceed). Persist immediately so goal.plan survives even if the
    // loop below stops early, and so goalPrompt picks up the new plan path.
    if (await maybeRefreshPlan(goal, d, nowMs)) {
      const fresh = readGoalsRaw();
      const target = fresh.find((g) => g.id === goal.id);
      if (target) {
        target.plan = goal.plan;
        target.updatedAt = nowMs;
        writeGoals(fresh);
      }
    }

    // Run ONE bounded loop toward the goal.
    let loopOutcome: "done" | "blocked" | "cap" | "error";
    try {
      loopOutcome = await d.runLoop({
        goal: goalPrompt(goal),
        agentName: "goal-" + goal.slug,
        maxIterations: goal.budget.maxIterations,
        // Background autonomy: its loop agent is hidden from the Canvas and torn
        // down when the tick's loop ends, so ticks never accrete idle 0-turn
        // cards (the suitehealth → suitehealth2 → suitehealth3 pollution).
        origin: "goal",
      });
    } catch {
      loopOutcome = "error";
    }

    let tick: GoalTick;

    if (loopOutcome === "done") {
      // The loop SAYS done. If a verifyCmd exists, it must pass before we
      // believe it — a false-DONE flips to blocked with the command output as
      // evidence (deterministic-repro principle: no self-graded progress).
      if (goal.verifyCmd) {
        const vr = await d.verify(goal.verifyCmd, DEFAULT_VERIFY_CWD);
        if (vr.code === 0) {
          tick = { ts: nowMs, status: "done", note: "loop DONE and verify passed", evidence: vr.output };
        } else {
          tick = {
            ts: nowMs,
            status: "blocked",
            note: `loop claimed DONE but verify exited ${vr.code}`,
            evidence: vr.output,
          };
        }
      } else {
        // No verify command — accept the loop's DONE at face value.
        tick = { ts: nowMs, status: "done", note: "loop DONE (no verify command)" };
      }
    } else if (loopOutcome === "blocked") {
      tick = { ts: nowMs, status: "blocked", note: "loop reported BLOCKED" };
    } else if (loopOutcome === "cap") {
      tick = { ts: nowMs, status: "progress", note: "loop made progress (iteration cap reached)" };
    } else {
      tick = { ts: nowMs, status: "progress", note: "loop stopped without a status (no progress claimed)" };
    }

    // A goal with an unconfirmed checkpoint is never auto-closed: hold it at
    // blocked so the owner confirms the gate before it can read as done.
    if (tick.status === "done" && hasPendingCheckpoint(goal)) {
      tick = {
        ts: nowMs,
        status: "blocked",
        note: "verify passed but a checkpoint needs the owner's confirmation",
        evidence: tick.evidence,
      };
    }

    // Persist the outcome onto the goal (status transition for done/blocked).
    const fresh = readGoalsRaw();
    const target = fresh.find((g) => g.id === goal.id);
    if (target) {
      target.lastTick = tick;
      target.updatedAt = nowMs;
      if (tick.status === "done") {
        target.status = "done";
        // A done tick means verify passed (or there was no verifyCmd to fail);
        // stamp the re-arm clock so the cadence counts from this success.
        target.lastVerify = nowMs;
      } else if (tick.status === "blocked") target.status = "blocked";
      writeGoals(fresh);
    }

    appendEvent({
      ts: nowMs,
      goalId: goal.id,
      slug: goal.slug,
      status: tick.status,
      note: tick.note,
      evidence: tick.evidence,
    });
    results.push({ slug: goal.slug, status: tick.status, note: tick.note, evidence: tick.evidence });
  }

  return { ran: results.length > 0, results };
}
