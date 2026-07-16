import { NextRequest } from "next/server";
import { requireReadAuth } from "@/lib/origin";
import { buildRetro } from "@/lib/usage-retro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET /api/usage/retro?days=30 → retrospective usage aggregates over the data
 * this install already records (quota ledger, TTS counters, update log). Owner
 * introspection of LOCAL data only: read-gated (session/control/phone) like the
 * rest of the read surface, and the handler performs NO network egress — it only
 * reads files under data/ (see lib/usage-retro.ts).
 *
 * Cheap on-demand aggregation with a small in-process cache (no cron).
 */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const days = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("days") || "30", 10) || 30, 1),
    90
  );
  return Response.json(buildRetro(days));
}
