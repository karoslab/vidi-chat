import fs from "node:fs";
import { dataDir, dataPath } from "./data-dir.ts";
import {
  DEFERRABLE_STEPS,
  isDeferrableStep,
  stepsToClearOnFinish,
  type DeferrableStep,
} from "./deferred-onboarding-steps.ts";

/**
 * Deferred-onboarding checklist (T2.4 — skip-and-defer).
 *
 * Every onboarding step (backend check, name, security notice, permissions,
 * starters, and the intro chat) has a visible Skip. Nothing blocks reaching a
 * working chat — a skip just files the step here, and SettingsPanel surfaces a
 * gentle "finish setting up" section with jump-back-in links (which reuse the
 * onboarding replay plumbing).
 *
 * Persisted under dataDir() (VIDI_DATA_DIR override, else <cwd>/data), like the
 * rest of the per-install state. Fail-open: a read/write failure never blocks
 * onboarding or the app — a missing/corrupt file just means "nothing deferred".
 *
 * The pure step set + the FW4 stepsToClearOnFinish decision live in
 * deferred-onboarding-steps.ts (no fs) so the client Onboarding component can
 * use them without pulling node:fs into the browser bundle; they're re-exported
 * here so server callers keep one import.
 */
export {
  DEFERRABLE_STEPS,
  isDeferrableStep,
  stepsToClearOnFinish,
  type DeferrableStep,
} from "./deferred-onboarding-steps.ts";

/** Plain-language label + one-line "what you'll finish" for each step, shown in
 *  the settings checklist. The single source of truth for the UI copy. */
export const DEFERRED_STEP_META: Record<DeferrableStep, { label: string; blurb: string }> = {
  backends: { label: "Connect your assistant", blurb: "Check that Claude or Codex is signed in." },
  name: { label: "Tell me your name", blurb: "So I can greet you by name." },
  security: { label: "See what I can and can’t do", blurb: "A quick, plain-language overview." },
  permissions: { label: "How I work", blurb: "Plan vs. Auto mode, and when I ask first." },
  helpers: { label: "Name your helpers", blurb: "Pick the name set for the helpers I send out." },
  starters: { label: "Things you can try", blurb: "A few example prompts to get going." },
  intro: { label: "Say hi to Vidi", blurb: "A short first chat to get set up." },
};

const deferredFile = () => dataPath("deferred-onboarding.json");

/** The set of currently-deferred steps, read live from disk. Corrupt/missing
 *  file → empty. Unknown values are filtered out (fixed-set guard). */
export function readDeferredSteps(): DeferrableStep[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(deferredFile(), "utf8"));
    if (Array.isArray(parsed)) {
      // De-dupe while preserving the canonical step order.
      const present = new Set(parsed.filter(isDeferrableStep));
      return DEFERRABLE_STEPS.filter((step) => present.has(step));
    }
  } catch {
    /* no file / corrupt — nothing deferred */
  }
  return [];
}

function writeDeferredSteps(steps: DeferrableStep[]): DeferrableStep[] {
  const ordered = DEFERRABLE_STEPS.filter((step) => steps.includes(step));
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(deferredFile(), JSON.stringify(ordered, null, 2));
  } catch {
    /* best-effort — a checklist write must never break onboarding */
  }
  return ordered;
}

/** File a step as deferred (idempotent). Ignores an unknown step. */
export function deferStep(step: string): DeferrableStep[] {
  if (!isDeferrableStep(step)) return readDeferredSteps();
  const current = new Set(readDeferredSteps());
  current.add(step);
  return writeDeferredSteps([...current]);
}

/** Remove a step from the checklist — called when the user finishes it (e.g.
 *  jumps back in from settings and completes the replay). Idempotent. */
export function resolveStep(step: string): DeferrableStep[] {
  if (!isDeferrableStep(step)) return readDeferredSteps();
  return writeDeferredSteps(readDeferredSteps().filter((s) => s !== step));
}

/** Clear the whole checklist — used when the flow is completed in full. */
export function clearDeferredSteps(): DeferrableStep[] {
  return writeDeferredSteps([]);
}
