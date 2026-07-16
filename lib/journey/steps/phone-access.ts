import { readiness } from "../../phone-access.ts";
import { lastPairingConsumedAtMs } from "../../phone-browser-pairing.ts";
import type { JourneyStep, VerifyResult } from "../types.ts";

/**
 * Journey Stage 6 — "Vidi on your phone". The last, OPTIONAL stage: it lets the
 * customer open Vidi in his phone's browser over his own private connection. It
 * must NEVER block the journey (skippable) — a customer who only ever uses Vidi
 * on the Mac is fully set up without it.
 *
 * The rich, multi-screen setup lives in components/journey/steps/PhoneAccess.tsx
 * (install + sign in on the Mac, install + sign in on the phone, turn the
 * connection on via the Vidi Helper menu, then the address + big pairing code).
 * Deep-link segment: /setup/step/phone-access.
 *
 * verify() is purely MECHANICAL and demands all three truths that make the phone
 * actually work end to end:
 *   1. the connection is turned on (tailscale serve forwards HTTPS to this app),
 *   2. this service already trusts the phone's address (so a page served under
 *      it ships the session token), and
 *   3. a phone browser has actually completed pairing at least once
 *      (lastPairingConsumedAtMs — the witness written when a one-time code is
 *      consumed). Clicking through the screens is NOT enough; a real phone must
 *      have connected.
 */

export const PHONE_ACCESS_STEP_ID = "phone-access";

export const phoneAccessStep: JourneyStep = {
  id: PHONE_ACCESS_STEP_ID,
  stage: 6,
  title: "Vidi on your phone",
  why: "Open Vidi in your phone's browser over your own private connection, so you can reach it when you are away from the Mac. This is optional.",
  outcome: "You opened Vidi on your phone once, and it stayed signed in.",
  skippable: true,
  async verify(): Promise<VerifyResult> {
    try {
      const r = await readiness();
      if (!r.tailscaleInstalled) {
        return {
          ok: false,
          reason: "Your private connection is not set up on this Mac yet. You can set it up or skip it. It is optional.",
          fixStepId: PHONE_ACCESS_STEP_ID,
        };
      }
      if (!r.loggedIn) {
        return {
          ok: false,
          reason: "You are not signed in to your private connection yet. Sign in on the Mac, or skip this. It is optional.",
          fixStepId: PHONE_ACCESS_STEP_ID,
        };
      }
      if (!r.serveActive || !r.trustedHostSet) {
        return {
          ok: false,
          reason: "Phone access is not turned on yet. Open the Vidi Helper menu on your Mac and choose Enable phone access, then check again. Or skip this, it is optional.",
          fixStepId: PHONE_ACCESS_STEP_ID,
        };
      }
      if (lastPairingConsumedAtMs() === null) {
        return {
          ok: false,
          reason: "Everything is ready. Open the address on your phone and type the code once to finish. Or skip this, it is optional.",
          fixStepId: PHONE_ACCESS_STEP_ID,
        };
      }
      return { ok: true, note: "Vidi is reachable from your phone over your private connection." };
    } catch {
      return {
        ok: false,
        reason: "Could not check phone access just now. You can try again or skip it. It is optional.",
        fixStepId: PHONE_ACCESS_STEP_ID,
      };
    }
  },
};

export default phoneAccessStep;
