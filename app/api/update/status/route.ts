import { requireReadAuth } from "@/lib/origin";
import { getStatus } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET /api/update/status → { phase, pct?, logTail, done, ok, error?, version? }.
 * Read-gated. The UI polls this while an update runs; after the process exits
 * and launchd respawns on the new code, the value is read back from the
 * persisted status file (which lives in the data dir, outside the swapped app
 * dir) so the fresh process still reports "done".
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(getStatus());
}
