import { clearKill, engageKill, killStatus, listRuns } from "@/lib/kill";
import { crossOriginResponse, requireReadAuth, sameOriginOk } from "@/lib/origin";
import { verifyControlToken } from "@/lib/control";
import { verifySessionToken } from "@/lib/session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Emergency stop.
 *
 * engage stays deliberately UNAUTHENTICATED — the fail-safe must work when quota
 * is exhausted or the store is corrupt, and it can only ever STOP things.
 *
 * clear (re-arm) GRANTS capability back — it re-enables the fleet — so it
 * requires a POSITIVE credential a remote tailnet peer cannot obtain: the
 * control token (Phase 4a — H7, the gate /api/control uses, for ops/vidictl)
 * OR the machine-local session token (the web UI's Resume button, injected
 * into the page by app/layout.tsx and unreadable off-disk). This is exactly
 * requireWriteAuth's {session, control} set — the browser holds the session
 * token but not the control token, so the in-app Resume needs it. sameOriginOk
 * (checked first, below) still additionally pins the browser to same-origin,
 * so the guarantee is unchanged: same-origin + a valid session/control token.
 * The spoken "clear the kill switch" path is unaffected: it re-arms via
 * lib/voice-turn → clearKill() directly, never through this HTTP route.
 *
 *   GET  → { engaged, since?, reason?, runs: [{pid,threadId,provider,startedAt}] }
 *        Token gated (Tier-2 fix-round finding 4): leaks live run pids/threadIds,
 *        and no browser or Swift-app caller was found to depend on an open read,
 *        so it's gated like the rest of the read surface rather than left silent.
 *   POST { action?: "engage"|"clear", reason? } → engage kills every
 *        registered CLI child and writes data/KILL; clear (token-gated) removes it.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ ...killStatus(), runs: listRuns() });
}

export async function POST(req: Request) {
  // Engage is a fail-safe (stop-only) so cross-origin engage is only a DoS,
  // but clear GRANTS capability back — guard the whole POST. Native clients
  // and curl (no Origin) are unaffected; only a browser cross-origin page is
  // rejected.
  if (!sameOriginOk(req)) return crossOriginResponse();
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = engage */
  }
  if (body.action === "clear") {
    // Re-arming the fleet is a capability grant, not a stop — require a positive
    // token so an unauthed local POST can't silently re-enable Vidi. Accept the
    // control token (ops/vidictl, unchanged) OR the browser session token (the
    // in-app Resume button — the web UI holds the session token, never the
    // control token). Both are the requireWriteAuth {session, control} set;
    // sameOriginOk above still pins the browser to same-origin.
    if (!verifyControlToken(req) && !verifySessionToken(req)) {
      return Response.json(
        { error: "invalid or missing token" },
        { status: 401 }
      );
    }
    clearKill();
    return Response.json({ engaged: false });
  }
  const { killed } = engageKill(
    typeof body.reason === "string" ? body.reason : "api"
  );
  return Response.json({ engaged: true, killed });
}
