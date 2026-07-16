import { NextRequest } from "next/server";
import { readQuota, summarizeQuota } from "@/lib/quota";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Usage ledger view — rolling 5h / 7d totals (the Claude Max quota windows)
 * plus the most recent entries. GET ?limit=20. Token gated (Tier-2): the
 * dashboard sends the injected session token; a tailnet peer has none → 401.
 */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") || "20", 10) || 20, 1),
    500
  );
  const recent = readQuota(Date.now() - 7 * 24 * 3600_000)
    .slice(-limit)
    .reverse();
  return Response.json({ ...summarizeQuota(), recent });
}
