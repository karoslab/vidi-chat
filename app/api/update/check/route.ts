import { requireReadAuth } from "@/lib/origin";
import { checkForUpdate } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET /api/update/check → { available, current, latest?, notes?, devBuild?,
 * error? }. Read-gated (session/control/phone) exactly like the rest of the
 * read surface. Talks to the vidi-proxy release manifest with the install's own
 * worker key (server-side only).
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(await checkForUpdate());
}
