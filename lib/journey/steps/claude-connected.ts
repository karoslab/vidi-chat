import type { JourneyStep } from "../types.ts";
import { claudeStatus } from "../../claude-setup.ts";

/**
 * Stage 2 — Vidi is connected to Claude.
 *
 * Phase A of the Helper demotion moved "Connect AI provider" INTO onboarding, so
 * this step is now the resume point for a customer who has neither installed nor
 * signed in to Claude. verify() reads the SAME tri-state the rich step screen
 * (components/journey/steps/ClaudeStep.tsx) branches on — claudeStatus() —
 * strengthening the old detectBackend probe with a runtime verb-discovery +
 * fallback chain (the CLI's status/login verbs have moved across versions).
 *
 * Fully mechanical: it does not care whether the customer visited the connect
 * screen, only whether the connection actually works right now. The reason is
 * plain-language (never raw stderr) and routes back to this step, whose screen
 * offers the right next action for the missing / signed-out state.
 */
export const claudeConnectedStep: JourneyStep = {
  id: "claude-connected",
  stage: 2,
  title: "Vidi is connected to Claude",
  why: "Claude is what Vidi thinks with. Without the connection, Vidi cannot answer you.",
  outcome: "A green tick here, and Vidi replies with real answers instead of an error.",
  primaryAction: { label: "Connect Claude", href: "/setup/step/claude-connected" },
  verify: async () => {
    const status = await claudeStatus();
    if (status === "signed-in") {
      return { ok: true, note: "Claude is connected and ready." };
    }
    if (status === "missing") {
      return {
        ok: false,
        reason: "Vidi's AI brain isn't installed yet. Open this step to install it, then sign in.",
        fixStepId: "claude-connected",
      };
    }
    return {
      ok: false,
      reason:
        "Vidi isn't signed in to Claude yet. Open this step, choose Open sign-in, and sign in with your own account.",
      fixStepId: "claude-connected",
    };
  },
};
