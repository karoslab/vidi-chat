import { listVisibleAgents } from "@/lib/agents/manager";
import { buildOverlay, readOverlayConfig } from "@/lib/overlay";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Sanitized fleet projection for the Crew Cam OBS overlay. Read-only GET;
 * whitelisted fields only (see lib/overlay.ts) so nothing sensitive reaches a
 * public stream. Config (day / revenue / goal) lives in data/overlay-config.json.
 * Token gated (Tier-2): still not an open read over the tailnet — the local
 * overlay page sends the injected session token.
 *
 * QA fix (PR #48 review): listVisibleAgents() (chat/manual origin only) — a
 * background goal-tick agent must never surface on a public stream overlay.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(buildOverlay(listVisibleAgents(), readOverlayConfig()));
}
