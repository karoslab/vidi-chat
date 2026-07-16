import { requireWriteAuth } from "@/lib/origin";
import { noteAppActivity } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * App-activity ping (DIAGNOSTICS + FEEDBACK loop). The web UI POSTs this once on
 * mount. It counts an active day (a "sessions" proxy) and, if the weekly health
 * summary is consented AND due (>= 7 days), sends it — this repo has no separate
 * scheduler, so the weekly summary is computed lazily on activity.
 *
 * requireWriteAuth because a send is a (consented) egress. The weekly send is
 * fire-and-forget from the client's view: the response never blocks on it beyond
 * the route's own await, and a send failure is silent (recorded to the ledger,
 * retried next window). Returns only whether a summary went out, for tests.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const outcome = await noteAppActivity();
  return Response.json({ summarySent: outcome.sent });
}
