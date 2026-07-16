import type { JourneyStep } from "../types.ts";

/**
 * Stage 1 — Vidi is running on this Mac.
 *
 * This check is trivially true: if any of this code is executing, the server is
 * up and answering. It exists so the very first row on the health screen is a
 * green tick the customer recognizes ("yes, it's on"), anchoring the rest.
 */
export const vidiRunningStep: JourneyStep = {
  id: "vidi-running",
  stage: 1,
  title: "Vidi is open and running",
  why: "This is the app that runs everything else. If it is on, the rest can be set up.",
  outcome: "A green tick here, and Vidi answers when you type.",
  verify: async () => ({ ok: true, note: "Vidi is open and answering on this Mac." }),
};
