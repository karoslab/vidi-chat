import { readiness } from "@/lib/phone-access";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET -> the phone-access readiness snapshot (see lib/phone-access.ts): is
 * Tailscale set up on this Mac, signed in, is the connection turned on, and does
 * this service already trust the phone. Read-gated (session / control / phone):
 * the same read surface as the rest of the setup board, no state change.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(await readiness());
}
