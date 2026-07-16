import { listNotes } from "@/lib/memory-controls";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → { notes: [...], fleetMemory: [...] } — everything Vidi remembers, so the
 * Memory page can show it. Token gated (requireReadAuth — Tier-2): notes carry
 * personal content, so this must not be an open read over the tailscale-serve
 * exposure. The browser sends the injected session token; a tailnet peer 401s.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(listNotes());
}
