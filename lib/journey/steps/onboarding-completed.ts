import type { JourneyStep } from "../types.ts";
import { isOnboarded } from "../../onboarding.ts";

/**
 * Stage 2 — first-time setup finished.
 *
 * Mechanical: isOnboarded() is true when the onboarded flag exists OR the
 * install already has saved conversations (the "existing data = onboarded"
 * rule, which is why the owner's 40-thread install always reports done). A fresh
 * install with no profile and no threads is NOT done, so this fails and becomes
 * the resume point until the customer finishes the short intro.
 */
export const onboardingCompletedStep: JourneyStep = {
  id: "onboarding-completed",
  stage: 2,
  title: "You finished the quick intro",
  why: "Telling Vidi your name and how you like it to talk makes every answer feel like yours.",
  outcome: "A green tick here, and Vidi greets you by name.",
  primaryAction: { label: "Finish the intro", href: "/" },
  verify: async () =>
    isOnboarded()
      ? { ok: true }
      : {
          ok: false,
          reason:
            "The quick intro is not finished yet. Tell Vidi your name and pick a style to wrap it up.",
          fixStepId: "onboarding-completed",
        },
};
