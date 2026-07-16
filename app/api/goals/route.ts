import { listGoals } from "@/lib/goals";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Standing goals API. GET /api/goals → the goal ledger. Token gated
 * (requireReadAuth — Tier-2): the browser sends the injected session token and
 * ops readers send the control token; a tailnet peer has neither, so the ledger
 * is not an open read over the tailscale-serve exposure. The scheduled sweep
 * lives at POST
 * /api/goals/tick (tick/route.ts) — control-token gated because it spends
 * autonomy budget. All policy (kill/quota deferral, per-goal daily budget,
 * verify-before-progress) lives in lib/goals so it's unit-tested with fakes.
 */

export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ goals: listGoals() });
}
