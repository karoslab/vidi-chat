import { readVoiceConfig, readVoiceKey, hasVoiceEgressConsent } from "../../voice-tier.ts";
import { isOwner } from "../../user-config.ts";
import type { JourneyStep, VerifyResult } from "../types.ts";

/**
 * Journey — "Vidi's voice" (2026-07-12, customer ask). OPTIONAL and skippable:
 * the Mac's own voice works out of the box, so this must never block the
 * journey. Complete when the install will actually speak premium end to end:
 * tier is premium AND (owner, or a voice code is stored AND consent given).
 * The primaryAction deep-links straight into Settings' Voice tab.
 */

export const PREMIUM_VOICE_STEP_ID = "premium-voice";

export const premiumVoiceStep: JourneyStep = {
  id: PREMIUM_VOICE_STEP_ID,
  stage: 6,
  title: "Vidi's voice",
  why: "Vidi speaks with your Mac's built-in voice from day one. A premium voice is more natural. This is optional.",
  outcome: "Vidi answers out loud in the premium voice you picked.",
  skippable: true,
  primaryAction: { label: "Pick her voice", href: "/?settings=voice" },
  async verify(): Promise<VerifyResult> {
    try {
      const config = readVoiceConfig();
      if (config.tier !== "premium") {
        return {
          ok: false,
          reason:
            "Vidi speaks with your Mac's built-in voice right now. Add a premium voice any time from Settings. It is optional.",
        };
      }
      if (isOwner()) {
        return { ok: true, note: "Premium voice is on. This install includes it." };
      }
      if (!readVoiceKey()) {
        return {
          ok: false,
          reason:
            "Premium is picked but no voice code is saved yet. Paste your code in Settings, or switch back to the system voice. It is optional.",
        };
      }
      if (!hasVoiceEgressConsent()) {
        return {
          ok: false,
          reason:
            "Premium needs the consent box in Settings ticked before it can turn on. It is optional.",
        };
      }
      return { ok: true, note: "Premium voice is on. Replies are spoken in the voice you picked." };
    } catch {
      return {
        ok: false,
        reason: "Could not check the voice setup just now. You can try again or skip it. It is optional.",
      };
    }
  },
};
