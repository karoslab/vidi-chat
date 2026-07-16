/**
 * UI capability gating — the owner vs a non-owner second user.
 *
 * These are the pure decision functions behind two productization changes:
 *   - hiding the Fleet nav item + inline swarm/attention panels from a
 *     non-owner install, and
 *   - collapsing the composer's power-user controls (Provider / Account / Model
 *     / Effort) under an "Advanced" disclosure for a non-owner.
 *
 * The single input is `ownerInstall` — the client-side mirror of
 * lib/user-config.ts `isOwner()`, delivered to the browser via
 * GET /api/onboarding. They live here (not inline in the React component)
 * because the repo has no React test harness, so the DECISIONS are extracted
 * and unit-tested while the JSX just reads them.
 *
 * Invariant: the OWNER install (VIDI_OWNER=1) must look EXACTLY as it does
 * today. Every function returns the owner-preserving value when
 * `ownerInstall` is true.
 */

/**
 * Show the Fleet nav item and the inline swarm / attention panels?
 * Owner only — a non-owner gets a simpler surface with no fleet chrome. The
 * capability is only hidden, never removed (the /canvas route still exists).
 */
export function shouldShowFleet(ownerInstall: boolean, actAllowed = false): boolean {
  // Builder-mode installs get the Work page too (2026-07-12): once Vidi can
  // send out helpers for you, you must be able to WATCH them work.
  return ownerInstall || actAllowed;
}

/**
 * Should the composer's "Advanced" group (Provider / Account / Model / Effort)
 * start COLLAPSED?
 *   - non-owner  -> true  (collapsed by default — a simple surface),
 *   - owner      -> false (expanded; the owner renders these flat, as today).
 */
export function advancedCollapsedByDefault(ownerInstall: boolean): boolean {
  return !ownerInstall;
}

/**
 * Render the Advanced controls behind a collapsible disclosure at all?
 *   - non-owner -> true  (wrap them in the "Advanced" disclosure),
 *   - owner     -> false (render them flat, byte-identical to today).
 */
export function showAdvancedDisclosure(ownerInstall: boolean): boolean {
  return !ownerInstall;
}
