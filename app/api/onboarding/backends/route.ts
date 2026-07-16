import { detectBackends } from "@/lib/credential-detect";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * First-run backend detection (T2.1). GET → { backends: BackendStatus[] } — the
 * onboarding step-0 UI (and its re-check button) reads this to show a green
 * check per verified backend and offer only the ones that actually work.
 *
 * Token gated (requireReadAuth — Tier-2): backend availability is install
 * fingerprinting, so it must not be an open read over the tailnet. The
 * onboarding UI sends the injected session token. Detection itself is fail-safe.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ backends: await detectBackends() });
}
