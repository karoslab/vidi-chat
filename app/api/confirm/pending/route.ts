import { pendingView } from "@/lib/confirm";
import { crossOriginResponse, requireReadAuth, sameOriginOk } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → { pending: { description, nonce, kind, expiresAt } | null }
 *
 * The browser confirm card polls this to learn whether a consequential action
 * (send email / create calendar event / hands / write-file) is parked in the
 * one-slot confirm queue (lib/confirm.ts), so a browser-first non-owner user can
 * see and approve it — the Swift overlay is no longer the only surface.
 *
 * Gate: sameOriginOk (CSRF, 403 cross-origin) + requireReadAuth (positive
 * session/control token, 401). The nonce is exposed ONLY to that
 * session-authenticated same-origin caller. A prompt-injected act-mode agent
 * cannot obtain the session or control token (both live in SECRET_PATHS, denied
 * to act-mode Read/Edit/Write and the Bash deny-secret-read hook), so handing
 * the nonce to this caller does not lower the gate below what the token already
 * provides — while the nonce keeps its remaining value on the browser path:
 * binding the Approve click to the exact action the user saw, so a depth-1 plan
 * mutation between poll and click fails closed in confirmPending's nonce match.
 * pendingView returns the REDACTED description only, never the raw payload.
 */
export async function GET(req: Request) {
  if (!sameOriginOk(req)) return crossOriginResponse();
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ pending: pendingView() });
}
