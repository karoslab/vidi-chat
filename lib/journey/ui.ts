import type { StepState } from "./types.ts";

/**
 * Pure, non-DOM helpers shared by StepFrame / SetupHealth. Kept out of the React
 * components so they can be unit-tested with plain `node --test` (the repo has no
 * DOM test infra) — the components are thin wrappers over these.
 */

/** The step-screen eyebrow, e.g. "Stage 2 · 2 of 6". `index` is 1-based. */
export function stepEyebrow(stage: number, index: number, total: number): string {
  return `Stage ${stage} · ${index} of ${total}`;
}

/** Plain-language label for a status, for the health rows. */
export function statusLabel(status: StepState["status"]): string {
  switch (status) {
    case "verified":
      return "Working";
    case "failed":
      return "Needs attention";
    case "pending":
      return "Waiting on the step above";
    case "skipped":
      return "Optional, not set up";
  }
}

/**
 * Build the message that pre-fills the chat when the customer taps "Ask Vidi"
 * from a step. It hands Vidi the step's context (title, id, and the last check
 * failure if any) so it can troubleshoot conversationally, in plain words.
 */
export function askVidiPrompt(step: Pick<StepState, "id" | "title" | "status" | "reason">): string {
  const lines = [`I'm on the setup step "${step.title}" and I need help.`];
  if (step.status === "failed" && step.reason) {
    lines.push(`Vidi says: ${step.reason}`);
  }
  lines.push(`(setup step: ${step.id})`);
  return lines.join("\n");
}

/** The deep-link to a step's own screen. The single URL convention every stage
 *  module and the SetupHealth "pick up" card share. */
export function stepHref(stepId: string): string {
  return `/setup/step/${encodeURIComponent(stepId)}`;
}
