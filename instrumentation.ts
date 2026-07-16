/**
 * Next.js server-startup hook (runs once when the server boots, dev or
 * `next start`). We eagerly materialize the control token here so
 * data/control-token exists before any vidictl call — otherwise the token is
 * only created lazily inside verifyControlToken(), which short-circuits on a
 * missing header, so vidictl could never obtain a token to send (bootstrap
 * deadlock).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Workspace-root sanity, once at boot. WORKSPACE_ROOT is derived from
  // import.meta.url, which in the PRODUCTION bundle points into the dist
  // dir's chunks — tests import the source module and can never catch a bad
  // bundled resolution, so this log is the only runtime signal. workspace.ts
  // falls back to cwd's parent when the module derivation fails validation.
  try {
    const { WORKSPACE_ROOT, WORKSPACE_ROOT_RESOLUTION } = await import(
      "./lib/workspace.ts"
    );
    if (WORKSPACE_ROOT_RESOLUTION.valid) {
      console.log(
        `[boot] WORKSPACE_ROOT=${WORKSPACE_ROOT} (via ${WORKSPACE_ROOT_RESOLUTION.via})`
      );
    } else {
      console.error(
        `[boot] WORKSPACE_ROOT MISRESOLVED: "${WORKSPACE_ROOT}" (via ${WORKSPACE_ROOT_RESOLUTION.via}) — ` +
          "no candidate contained vidi-chat/package.json; MyWiki/gbrain/act-mode paths will be wrong. " +
          "Set VIDI_WORKSPACE_ROOT or fix the service WorkingDirectory."
      );
    }
  } catch {
    /* never let a diagnostics import block boot */
  }

  const { getControlToken } = await import("./lib/control.ts");
  getControlToken();

  // Same for the phone token (C5): materialize data/phone-token at boot so the
  // user can copy it into the iOS Shortcut before ever hitting /api/phone/ask.
  try {
    const { getPhoneToken } = await import("./lib/phone-token.ts");
    getPhoneToken();
  } catch {
    /* token file unwritable — the route still creates it lazily on first call */
  }

  // First-run onboarding backfill (P4.1): mark an EXISTING install (the owner,
  // saved threads) as onboarded at boot so he can never see the first-run flow.
  // A truly fresh install is a no-op. The node:fs/path work lives inside
  // onboarding.ts (nodejs-only, reached only past the NEXT_RUNTIME guard above).
  try {
    const { ensureExistingInstallOnboarded } = await import("./lib/onboarding.ts");
    ensureExistingInstallOnboarded();
  } catch {
    /* the existing-data rule still gates the UI even if this backfill fails */
  }

  // Start the proactivity broker once at boot. Defensive like the token
  // materialization above: a broker that can't start must never take the whole
  // server down, so a failed import/start is swallowed — the app still serves.
  try {
    const { startEventBroker } = await import("./lib/events.ts");
    startEventBroker();
  } catch {
    /* broker unavailable — voice + chat still work; proactivity just stays off */
  }
}
