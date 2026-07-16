import { verifyControlToken } from "@/lib/control";
import { tickGoals } from "@/lib/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/goals/tick — run one scheduled standing-goals sweep. Control-token
 * gated (mirrors lib/control usage) because a tick spawns loop agents and thus
 * spends autonomy/quota budget. An optional scheduled job (launchd/cron)
 * curls this four times a day with the data/control-token.
 */

export async function POST(req: Request) {
  if (!verifyControlToken(req)) {
    return Response.json({ error: "invalid or missing control token" }, { status: 401 });
  }
  try {
    const result = await tickGoals();
    return Response.json({ ok: true, ...result });
  } catch (e: any) {
    // Fail-open: the tick's internals already swallow errors, but a top-level
    // guard keeps a scheduled curl from ever getting a 500.
    return Response.json({ ok: false, ran: false, results: [], error: e?.message || "tick failed" });
  }
}
