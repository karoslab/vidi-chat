import { exportMemory } from "@/lib/memory-controls";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → the full memory manifest as a downloadable JSON attachment. Read gated
 * (requireReadAuth — Tier-2), same as the list route: the payload is all of
 * Vidi's memory. The Content-Disposition makes the browser save it as a file.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const payload = exportMemory();
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="vidi-memory-export.json"',
    },
  });
}
