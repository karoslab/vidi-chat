import { status, apiWhoAmI, NOT_INSTALLED_MSG } from "../../github-connect.ts";
import type { JourneyStep } from "../types.ts";

/**
 * Journey Stage 4 — "Your GitHub". The step contract (JourneyStep) comes from
 * the shared framework at lib/journey/types.ts. Deep-link convention for this
 * step: /setup/step/github-connect. The rich device-code screen
 * (components/journey/steps/GithubStep.tsx) renders its own actions, so this
 * step needs no primaryAction.
 */

/** The device-code screen's step id — a failed verify() sends the customer back
 *  here to reconnect. Also the deep-link segment: /setup/step/github-connect. */
export const GITHUB_CONNECT_STEP_ID = "github-connect";

/**
 * Stage 4 verify: the account is connected AND a real GitHub API call succeeds.
 * A stored credential alone isn't enough — a token revoked after connecting must
 * fail here — so we make an actual `gh api user` round-trip (apiWhoAmI). On any
 * failure we point the customer back to the device-code screen with a plain
 * reason. Wrapped so a bug in status()/apiWhoAmI() resolves {ok:false} instead
 * of throwing, per the "verify() must not throw" contract.
 */
export const githubStep: JourneyStep = {
  id: GITHUB_CONNECT_STEP_ID,
  stage: 4,
  title: "Your GitHub",
  why: "GitHub gives Vidi a private, safe place to keep a backup of everything you and Vidi remember. This is optional.",
  outcome: "You're connected to GitHub and your memory is backed up.",
  // Optional: a cloud backup is nice-to-have, not required to use Vidi, and it
  // needs the GitHub CLI which a fresh customer Mac may not have. Skippable so
  // it never dead-ends a non-technical person (2026-07-12 family install).
  skippable: true,
  async verify() {
    try {
      const s = await status();
      if (s.notInstalled) {
        return {
          ok: false,
          reason: NOT_INSTALLED_MSG,
          fixStepId: GITHUB_CONNECT_STEP_ID,
        };
      }
      if (!s.connected) {
        return {
          ok: false,
          reason: "You're not connected to GitHub yet. Let's connect your account.",
          fixStepId: GITHUB_CONNECT_STEP_ID,
        };
      }
      const who = await apiWhoAmI();
      if (!who.ok) {
        return { ok: false, reason: who.reason, fixStepId: GITHUB_CONNECT_STEP_ID };
      }
      return { ok: true, note: `Connected as ${who.login}. Your memory can be backed up.` };
    } catch {
      // Contract: verify() must never throw. An unexpected error becomes a
      // plain-language failure that routes back to the device-code step.
      return {
        ok: false,
        reason: "Couldn't check your GitHub connection just now. Please try again.",
        fixStepId: GITHUB_CONNECT_STEP_ID,
      };
    }
  },
};

export default githubStep;
