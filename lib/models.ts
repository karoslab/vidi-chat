import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * Model + effort router — the harness brain. Every Claude turn (chat UI and
 * voice) resolves through here so the switching is REAL: the resolved model
 * and effort become actual `--model` / `--effort` / `--fallback-model` CLI
 * flags, never prose rules.
 *
 * Routing policy (post-fable; effort routing updated 2026-07-07):
 *   - Fable (the model) is retired. Deep work — plan mode, or ultra effort —
 *     goes to opus with the `ultracode` keyword injected. That keyword is the
 *     CLI's opt-in for multi-agent workflow orchestration, so opus compensates
 *     for fable's depth with fan-out, not with a rules file.
 *   - Any opus route always injects `ultracode`. Auto-routed sonnet turns run at
 *     the REQUESTED effort (moderate by default) — NOT a forced "max". Max
 *     reasoning is reserved for deliberately deep turns (which already route to
 *     opus: plan mode or the ultra dial) and for explicit user dials. Pinning
 *     every shallow voice ask to "max" is what turned a trivial calendar
 *     question into a 7-minute, 14-turn burn (fixed 2026-07-07). A thread-pinned
 *     or explicit effort always wins.
 *   - "fable" is still accepted as an explicit pick / stored thread pin for
 *     back-compat — it now resolves to opus+ultracode, never a dead model.
 *   - Effort follows the tier (token-discipline policy, the owner): a DEEP/opus
 *     route with no explicit effort defaults to "high" (planning/review reasons
 *     hard); a mechanical (sonnet) route keeps the "medium" default. An explicit
 *     or thread-pinned effort always wins over the tier default. See
 *     DEEP_DEFAULT_EFFORT and lib/model-policy.ts (the fleet/worker defaults).
 */

/**
 * The canonical reasoning-effort ladder (ascending). Six stops (FIX 6). The
 * chat UI labels them Low / Med / High / Extra / Max / Ultracode — "extra" is
 * the internal `xhigh`, "ultracode" is the internal `ultra` (top). Each provider
 * maps a chosen level to its REAL --effort flag and CLAMPS anything above its own
 * ceiling down (claude/grok top out at "max"; codex clamps per-model). We never
 * pass a provider an effort string it rejects — clamp, never error.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type VidiMode = "plan" | "auto";

/** Ascending order — index is the rank used for comparison and clamping. */
export const EFFORT_LADDER: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export function effortRank(e: Effort): number {
  const i = EFFORT_LADDER.indexOf(e);
  return i < 0 ? EFFORT_LADDER.indexOf("medium") : i;
}

/** Clamp an effort down to a provider's ceiling (never up). */
export function clampEffort(e: Effort, ceiling: Effort): Effort {
  return effortRank(e) > effortRank(ceiling) ? ceiling : e;
}

/** Claude's CLI accepts low/medium/high/xhigh/max (verified `claude --help`),
 *  so anything above "max" (i.e. "ultra") clamps to max. */
export function claudeEffort(e: Effort): string {
  return clampEffort(e, "max");
}

export function normalizeEffort(v: unknown): Effort {
  return typeof v === "string" && (EFFORT_LADDER as readonly string[]).includes(v)
    ? (v as Effort)
    : "medium";
}

/** Legacy thread modes map onto the two real modes: chat→plan, act→auto. */
export function normalizeMode(v: unknown): VidiMode {
  if (v === "auto" || v === "act") return "auto";
  return "plan";
}

export interface ResolvedRun {
  /** Actual model passed to --model: "opus" | "sonnet" (fable is retired). */
  model: string;
  /** Passed to --fallback-model when set. Retained for back-compat; the router
   *  no longer emits it now that nothing routes to fable. */
  fallbackModel?: string;
  /** Actual value for --effort. */
  cliEffort: string;
  /** Deep turn (or an explicit/pinned "fable") → opus with the `ultracode`
   *  keyword injected so opus runs multi-agent workflows for the turn. */
  ultracode: boolean;
}

/* ---------------------------------------------------------------------- */
/* Fable availability (retired)                                            */
/* ---------------------------------------------------------------------- */

// Resolved at CALL time via the shared dataDir() (VIDI_DATA_DIR override, else
// <cwd>/data) — unset is byte-identical to <cwd>/data/model-availability.json.
const availabilityFile = () => dataPath("model-availability.json");

interface AvailabilityCache {
  fableAvailable: boolean;
  checkedAt: number;
  source: "probe" | "run";
}

function writeCache(c: AvailabilityCache) {
  try {
    fs.mkdirSync(path.dirname(availabilityFile()), { recursive: true });
    const tmp = `${availabilityFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, availabilityFile());
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Fable (the model) is retired, so it is never available. The router no longer
 * calls this — deep/explicit-fable turns unconditionally degrade to
 * opus+ultracode — but it is kept as defensive dead code for any external
 * caller, and it never spawns a live probe.
 */
export function isFableAvailable(): boolean {
  return false;
}

/**
 * Opportunistic learning from real runs: claude.ts still reports the models the
 * CLI actually used on a turn. Kept as defensive dead code alongside the
 * claude.ts opus-downgrade retry — the cache it writes is no longer read by the
 * router now that fable is retired.
 */
export function recordFableObservation(usedModels: string[]) {
  if (usedModels.length === 0) return;
  writeCache({
    fableAvailable: usedModels.some((m) => m.includes("fable")),
    checkedAt: Date.now(),
    source: "run",
  });
}

/* ---------------------------------------------------------------------- */
/* The router                                                              */
/* ---------------------------------------------------------------------- */

/** The effort a DEEP turn (plan mode / the opus route) runs at when the caller
 *  gave no explicit effort. Token-discipline policy (the owner): planning/review
 *  is the top tier and defaults to "high" — NOT "medium" and NOT the burn-prone
 *  "max". A mechanical (sonnet) turn keeps the "medium" default. An explicit
 *  or thread-pinned effort always wins over this (see resolveRun). */
export const DEEP_DEFAULT_EFFORT: Effort = "high";

/** True only when the caller passed a real ladder level. Lets resolveRun tell
 *  "no effort supplied" (→ tier default) apart from an explicit "medium". */
function effortWasProvided(v: unknown): boolean {
  return typeof v === "string" && (EFFORT_LADDER as readonly string[]).includes(v);
}

/** The deep/reasoning model: Fable when the CLI actually has it, else Opus.
 *  Honors "deep reasoning on Fable if available, otherwise Opus" (2026-07-12)
 *  without ever routing to a model the CLI would reject — isFableAvailable()
 *  is fail-safe false until a real run proves Fable is there. */
function deepModel(): "fable" | "opus" {
  return isFableAvailable() ? "fable" : "opus";
}

export function resolveRun(args: {
  /** "auto" (or null) = Vidi routes; or an explicit "fable"|"opus"|"sonnet". */
  model?: string | null;
  mode?: unknown;
  effort?: unknown;
}): ResolvedRun {
  const mode = normalizeMode(args.mode);
  const provided = effortWasProvided(args.effort);
  const effort = normalizeEffort(args.effort);
  const cliEffort = claudeEffort(effort);
  const requested = args.model ?? "auto";

  // Effort for a DEEP route: the explicit dial wins; absent, the deep tier
  // defaults to DEEP_DEFAULT_EFFORT ("high"). Mechanical (sonnet) turns keep
  // the plain "medium" default via `cliEffort`.
  const deepCliEffort = claudeEffort(provided ? effort : DEEP_DEFAULT_EFFORT);

  // The `ultracode` multi-agent-orchestration keyword fires ONLY when the user
  // explicitly cranks the effort dial to its top stop ("Ultracode" = the
  // internal `ultra`). It is NEVER injected silently on an ordinary plan turn —
  // that override was turning a "Medium" plan reply into a fleet fan-out
  // (2026-07-12 demo: the reply said "you've got ultracode in there").
  const wantsUltra = effort === "ultra";

  // Explicit model pins honor the exact dial (deep default only when absent).
  if (requested === "fable") {
    return { model: deepModel(), cliEffort: deepCliEffort, ultracode: wantsUltra };
  }
  if (requested === "opus") {
    return { model: "opus", cliEffort: deepCliEffort, ultracode: wantsUltra };
  }
  if (requested === "sonnet") {
    return { model: "sonnet", cliEffort, ultracode: wantsUltra };
  }

  // Auto (Vidi routes) — the global rule, split by MODE, effort honored:
  //   - Plan / reasoning → the deep model (Fable if available, else Opus).
  //     Planning always reasons deeply; the dial sets HOW hard.
  //   - Build / execution → Sonnet, always. The exception: the user explicitly
  //     asks for the top "Ultracode" tier, which is the fan-out (an Opus
  //     orchestrator directing Sonnet workers), so it routes to opus+ultracode.
  if (mode === "plan") {
    return { model: deepModel(), cliEffort: deepCliEffort, ultracode: wantsUltra };
  }
  if (wantsUltra) {
    return { model: "opus", cliEffort: deepCliEffort, ultracode: true };
  }
  return { model: "sonnet", cliEffort, ultracode: false };
}
