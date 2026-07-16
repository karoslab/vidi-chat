import { listPendingWork } from "../../approvals.ts";
import { webhookReady } from "../../discord-notify.ts";
import type { JourneyStep, VerifyResult } from "../types.ts";
import { stepHref } from "../ui.ts";

/**
 * Stage 5 journey steps: "Your approval desk" (+ the optional Discord mirror).
 *
 * The step contract (JourneyStep, VerifyResult) comes from the shared framework
 * at lib/journey/types.ts. `skippable` is a framework field the Discord mirror
 * relies on: when its verify() returns ok:false the engine records it as
 * "skipped", so the journey never blocks on it (degrade to in-app-only).
 */

export const APPROVAL_DESK_STEP_ID = "approval-desk";
export const DISCORD_MIRROR_STEP_ID = "discord-mirror";

/**
 * The approval desk itself. Completion just means the desk is reachable and can
 * read the customer's pending work — the desk is where every future approval
 * happens, so reaching it is the milestone (an empty desk is still "ok"; it
 * means there's simply nothing waiting). Fails only if listing throws, which
 * points the customer back at nothing to fix here.
 */
export const approvalDeskStep: JourneyStep = {
  id: APPROVAL_DESK_STEP_ID,
  stage: 5,
  title: "Your approval desk",
  why: "The desk is where Vidi brings you anything that needs your OK before it happens.",
  outcome: "A green tick here, and your approval desk is open and reading your work.",
  primaryAction: { label: "Open your desk", href: stepHref(APPROVAL_DESK_STEP_ID) },
  async verify(): Promise<VerifyResult> {
    try {
      const cards = await listPendingWork();
      const n = cards.length;
      return {
        ok: true,
        note:
          n === 0
            ? "Nothing waiting for you right now."
            : `${n} thing${n === 1 ? "" : "s"} waiting for your OK.`,
      };
    } catch {
      // Listing is fail-open internally, so this is defensive; the desk still
      // exists, so treat it as reachable.
      return { ok: true, note: "Your approval desk is ready." };
    }
  },
};

/**
 * The Discord mirror. SKIPPABLE — the journey must never block on it (degrade to
 * in-app only). Complete only when a webhook URL is stored AND its last test
 * ping returned 2xx (webhookReady). If not, point the customer at the setup step
 * itself to (re)paste and re-test.
 */
export const discordMirrorStep: JourneyStep = {
  id: DISCORD_MIRROR_STEP_ID,
  stage: 5,
  title: "Get a ping on your phone",
  why: "Connect a free Discord channel and Vidi can ping your phone when work is waiting. This is optional.",
  outcome: "Either you connected Discord, or you chose to skip it. Both are fine, the desk works either way.",
  skippable: true,
  async verify(): Promise<VerifyResult> {
    if (webhookReady()) {
      return { ok: true, note: "Discord will mirror your work notifications." };
    }
    return {
      ok: false,
      reason: "Discord isn't connected yet. You can set it up or skip it. It's optional.",
      fixStepId: DISCORD_MIRROR_STEP_ID,
    };
  },
};

export const stage5Steps: JourneyStep[] = [approvalDeskStep, discordMirrorStep];
