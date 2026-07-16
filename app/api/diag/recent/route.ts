import { requireReadAuth } from "@/lib/origin";
import { diagCategoryCounts, readRecentDiag } from "@/lib/diag-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Recent-errors read surface for the "Recent errors" affordance in Settings.
 * GET → { entries: [{ ts, category, message }], counts } — plain, already
 * scrubbed by the ledger (no chat content / paths / tokens). requireReadAuth.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({
    entries: readRecentDiag(10).map((e) => ({
      ts: e.ts,
      category: e.category,
      message: e.message,
    })),
    counts: diagCategoryCounts(),
  });
}
