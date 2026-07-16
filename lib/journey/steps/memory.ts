import {
  countNotes,
  readMemoryState,
  scaffoldWiki,
  verifyWiki,
} from "../../memory-wiki.ts";
import type { JourneyStep } from "../types.ts";
import { stepHref } from "../ui.ts";

/**
 * Stage 3 of the Vidi Journey — "Your memory" — as journey steps. The step
 * contract (JourneyStep) and the deep-link helper (stepHref) come from the
 * shared framework: lib/journey/types.ts and lib/journey/ui.ts. Deep-link
 * convention every step shares: /setup/step/<id>.
 */

const STAGE = 3;

/**
 * Step 1: set up the memory folder. verify() is the truth check the framework
 * gates on, so it also scaffolds when nothing exists yet (idempotent) and then
 * reports the real state of the folder. Wrapped so a disk error never escapes
 * as a throw.
 */
export const memoryWikiStep: JourneyStep = {
  id: "memory-wiki",
  stage: STAGE,
  title: "Set up your memory",
  why: "Your memory is where Vidi keeps what you tell it, in plain notes you can read yourself.",
  outcome: "A green tick here, and you have a memory folder with at least one note in it.",
  primaryAction: { label: "Set it up", href: stepHref("memory-wiki") },
  async verify() {
    try {
      scaffoldWiki();
      const result = verifyWiki();
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason ?? "Your memory is not ready yet.",
          fixStepId: "memory-wiki",
        };
      }
      const notes = countNotes();
      return { ok: true, note: `Your memory has ${notes} ${notes === 1 ? "note" : "notes"}.` };
    } catch {
      return {
        ok: false,
        reason: "I could not set up your memory folder just now. Try again in a moment.",
        fixStepId: "memory-wiki",
      };
    }
  },
};

/**
 * Step 2: the short seed interview. Passes once the interview has run and
 * written its notes; until then it points the customer back to the interview.
 */
export const memoryInterviewStep: JourneyStep = {
  id: "memory-interview",
  stage: STAGE,
  title: "Answer a few questions",
  why: "Five short questions give Vidi enough to be useful from day one, instead of starting blank.",
  outcome: "A green tick here, and Vidi already knows a bit about you and what you're doing.",
  primaryAction: { label: "Answer the questions", href: stepHref("memory-interview") },
  async verify() {
    try {
      const state = readMemoryState();
      if (!state.interviewDoneAt) {
        return {
          ok: false,
          reason: "Answer the few short questions to fill in your memory.",
          fixStepId: "memory-interview",
        };
      }
      return {
        ok: true,
        note: `You answered the questions and got ${state.interviewNotes} ${state.interviewNotes === 1 ? "note" : "notes"}.`,
      };
    } catch {
      return {
        ok: false,
        reason: "I could not check your memory just now. Try again in a moment.",
        fixStepId: "memory-interview",
      };
    }
  },
};

/**
 * Step 3: bring in a folder. This step is optional by design (consent scoped),
 * so it always passes. The note tells the customer whether they brought
 * anything in, without ever blocking the journey on it.
 */
export const memoryBringStuffStep: JourneyStep = {
  id: "memory-bring-stuff",
  stage: STAGE,
  title: "Bring in your stuff",
  why: "If you already keep notes somewhere, Vidi can read them once so you don't start from zero. This is optional.",
  outcome: "Either you brought in a folder, or you chose to skip it for now. Both are fine.",
  primaryAction: { label: "Bring in a folder", href: stepHref("memory-bring-stuff") },
  async verify() {
    try {
      const state = readMemoryState();
      if (state.imports.length === 0) {
        return { ok: true, note: "You can bring in a folder now or any time later." };
      }
      const total = state.imports.reduce((sum, i) => sum + i.notes, 0);
      return {
        ok: true,
        note: `You brought in ${state.imports.length} ${state.imports.length === 1 ? "folder" : "folders"}, ${total} ${total === 1 ? "note" : "notes"}.`,
      };
    } catch {
      // This step is optional and never blocks the journey, even on error.
      return { ok: true, note: "You can bring in a folder now or any time later." };
    }
  },
};

/** All Stage 3 steps in order, for the integration PR to register. */
export const memorySteps: JourneyStep[] = [
  memoryWikiStep,
  memoryInterviewStep,
  memoryBringStuffStep,
];
