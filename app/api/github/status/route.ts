import { requireReadAuth } from "@/lib/origin";
import { status } from "@/lib/github-connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET /api/github/status → { connected, login }. Read-gated. The device-code
 * screen polls this to learn when the customer has finished connecting on
 * github.com. No token is ever exposed — only the connected flag + username.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const s = await status();
  if (s.notInstalled) {
    return Response.json({ connected: false, login: null, notInstalled: true });
  }
  return Response.json({ connected: s.connected, login: s.login });
}
