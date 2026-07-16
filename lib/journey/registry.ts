import fs from "node:fs";
import path from "node:path";
import { dataDir, secureDataFile } from "../data-dir.ts";
import { recordDiag } from "../diag-ledger.ts";
import type { JourneyStep, JourneyState, StepState } from "./types.ts";
import { vidiRunningStep } from "./steps/vidi-running.ts";
import { claudeConnectedStep } from "./steps/claude-connected.ts";
import { onboardingCompletedStep } from "./steps/onboarding-completed.ts";
import { memorySteps } from "./steps/memory.ts";
import { githubStep } from "./steps/github.ts";
import { stage5Steps } from "./steps/approvals.ts";
import { premiumVoiceStep } from "./steps/premium-voice.ts";
import { phoneAccessStep } from "./steps/phone-access.ts";

// ───────────────────────────────────────────────────────────────────────────
//  THE REGISTRY — ordered. Resume position walks this list top to bottom.
//
//  STAGE-3-5 REGISTRATION POINTS (owned by other agents, do not remove):
//  Each stage module lives under lib/journey/steps/<name>.ts and default-exports
//  a JourneyStep (required surface: { id, stage, title, verify }; SHOULD also set
//  why / outcome / primaryAction for the screen). To register it, add ONE import
//  above and ONE entry to STEPS below, in stage order:
//
//    Stage 3 — Memory:    import { memoryConnectedStep }   from "./steps/memory-connected.ts";
//    Stage 4 — GitHub:    import { githubConnectedStep }   from "./steps/github-connected.ts";
//    Stage 5 — Approvals: import { approvalsConfiguredStep } from "./steps/approvals-configured.ts";
//
//  Then drop the export into STEPS at the marked slot. Nothing else in this file
//  needs to change — the engine, cache, and API pick up the new step automatically.
// ───────────────────────────────────────────────────────────────────────────
const STEPS: JourneyStep[] = [
  vidiRunningStep, //         stage 1
  claudeConnectedStep, //     stage 2
  onboardingCompletedStep, // stage 2
  // ── stage 3-5 steps, in order ──
  ...memorySteps, //          stage 3: memory-wiki, memory-interview, memory-bring-stuff
  githubStep, //              stage 4: github-connect
  ...stage5Steps, //          stage 5: approval-desk, discord-mirror (skippable)
  premiumVoiceStep, //        stage 6: premium-voice (SKIPPABLE — Mac voice works by default)
  phoneAccessStep, //         stage 6: phone-access (SKIPPABLE — optional last stage)
];

/** The live, ordered registry. */
export function getSteps(): readonly JourneyStep[] {
  return STEPS;
}

// ───────────────────────────────────────────────────────────────────────────
//  THE CACHE (data/journey.json).
//
//  This is ONLY a cache: it records the last computed pass for instant paint and
//  timestamps. It is NEVER read to decide the current position — computeJourney()
//  always re-runs verify() from scratch. A stale or missing cache cannot get the
//  customer lost, because it is not consulted for position at all.
// ───────────────────────────────────────────────────────────────────────────
const cachePath = () => path.join(dataDir(), "journey.json");

export function readJourneyCache(): JourneyState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (parsed && Array.isArray(parsed.steps)) return parsed as JourneyState;
  } catch {
    /* no cache yet — a fresh compute will write one */
  }
  return null;
}

function writeJourneyCache(state: JourneyState): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(state, null, 2));
    secureDataFile(cachePath());
  } catch {
    /* best-effort: a cache write must never break the response */
  }
}

/** Carry the static UI fields onto a StepState so the client can render without
 *  the (server-only) verify function. */
function baseState(step: JourneyStep): Pick<StepState, "id" | "stage" | "title" | "why" | "outcome" | "primaryAction"> {
  return {
    id: step.id,
    stage: step.stage,
    title: step.title,
    why: step.why,
    outcome: step.outcome,
    primaryAction: step.primaryAction,
  };
}

/** Run one step's verify() into a StepState. A step SHOULD return ok:false
 *  rather than throw; a throw is treated as a soft failure so a bad check can
 *  never crash the journey. Shared by computeJourney() and recheckStep(). */
async function runOne(step: JourneyStep, checkedAt: string): Promise<StepState> {
  try {
    const result = await step.verify();
    if (result.ok) {
      return { ...baseState(step), status: "verified", note: result.note, checkedAt };
    }
    return {
      ...baseState(step),
      status: "failed",
      reason: result.reason,
      fixStepId: result.fixStepId ?? step.id,
      checkedAt,
    };
  } catch (err: any) {
    // Observe-only: a step's verify() throwing is a genuine bug (distinct from
    // an ordinary "not connected yet" ok:false), so it's the one journey outcome
    // worth a ledger entry — the diag-ledger scrubs the message before it ever
    // touches disk. The returned StepState/behavior here is unchanged.
    recordDiag("journey-verify-fail", `${step.id}: ${err?.message ?? String(err)}`);
    return {
      ...baseState(step),
      status: "failed",
      reason: "This check could not run just now. Try Check again in a moment.",
      fixStepId: step.id,
      checkedAt,
    };
  }
}

/**
 * THE never-get-lost core. Run verify() down the registry and STOP at the first
 * failure — that step is the resume point (status "failed"), everything after it
 * is "pending" (grey dash, waiting on the broken step). Everything before it is
 * "verified". Writes the result to the cache and returns it.
 *
 * `steps` is injectable so tests can drive it with mock steps; production passes
 * the real registry.
 */
export async function computeJourney(
  steps: readonly JourneyStep[] = getSteps()
): Promise<JourneyState> {
  const computedAt = new Date().toISOString();
  const out: StepState[] = [];
  let currentStepId: string | null = null;

  for (const step of steps) {
    if (currentStepId) {
      // A prior step already failed — do not evaluate this one. It waits on the
      // broken step being fixed first (the linear-journey dependency).
      out.push({ ...baseState(step), status: "pending" });
      continue;
    }
    const state = await runOne(step, computedAt);
    if (state.status === "failed" && step.skippable) {
      // Optional step: record it as "skipped" and move on. It is NOT the resume
      // point, so it never blocks the journey or its completion (the Discord
      // mirror degrades to in-app-only). The reason is kept so the customer can
      // still choose to set it up.
      out.push({ ...state, status: "skipped" });
      continue;
    }
    out.push(state);
    if (state.status === "failed") currentStepId = step.id;
  }

  const journey: JourneyState = {
    steps: out,
    currentStepId,
    complete: currentStepId === null,
    computedAt,
  };
  writeJourneyCache(journey);
  return journey;
}

/**
 * Re-verify ONE step (POST { stepId, action:"recheck" }). Runs only that step's
 * verify — cheap, scoped to what the customer just fixed. Returns the fresh
 * StepState, or null when the id is unknown. Does not touch the cached full
 * pass; the client re-fetches GET /api/journey to refresh ordering.
 */
export async function recheckStep(
  stepId: string,
  steps: readonly JourneyStep[] = getSteps()
): Promise<StepState | null> {
  const step = steps.find((s) => s.id === stepId);
  if (!step) return null;
  return runOne(step, new Date().toISOString());
}
