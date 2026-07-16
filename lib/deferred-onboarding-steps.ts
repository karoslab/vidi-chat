/**
 * Deferred-onboarding — the PURE (no-fs) core of the skip-and-defer checklist.
 *
 * Split out from deferred-onboarding.ts so a CLIENT component (Onboarding.tsx)
 * can import the pure step set + the stepsToClearOnFinish decision WITHOUT
 * pulling node:fs into the browser bundle (the fs-backed read/write/defer/
 * resolve/clear helpers stay in deferred-onboarding.ts, which re-exports from
 * here so server callers keep a single import).
 */

/** The onboarding steps that can be skipped and later resumed. Kept in a fixed
 *  set so a stray value from disk/the request can't inject an arbitrary item. */
export const DEFERRABLE_STEPS = [
  "backends",
  "name",
  "security",
  "permissions",
  "helpers",
  "starters",
  "intro",
] as const;
export type DeferrableStep = (typeof DEFERRABLE_STEPS)[number];

export function isDeferrableStep(value: unknown): value is DeferrableStep {
  return typeof value === "string" && (DEFERRABLE_STEPS as readonly string[]).includes(value);
}

/**
 * FW4 — which deferred items a finish() run should clear. Pure so the
 * "skipped-step items survive a finish" guarantee is unit-testable and so the
 * client Onboarding component can call it without touching fs.
 *
 * ONLY steps actually completed in the run are cleared: `completedStepIds` are
 * the steps advanced via their primary action, plus the starters step when the
 * finish was reached by its own primary action (not by SKIPPING starters). A
 * step the user skipped this run is absent from both, so its freshly-filed
 * checklist item survives — the bug was a blanket clear that erased it. Unknown
 * ids are filtered out and the result is de-duped in canonical order.
 */
export function stepsToClearOnFinish(
  completedStepIds: readonly string[],
  starterStepCompleted: boolean
): DeferrableStep[] {
  const done = new Set(completedStepIds.filter(isDeferrableStep));
  if (starterStepCompleted) done.add("starters");
  return DEFERRABLE_STEPS.filter((step) => done.has(step));
}
