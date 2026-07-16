import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";
import { setWeeklySummaryConsent, weeklySummaryConsent } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Weekly-health-summary consent toggle (DIAGNOSTICS + FEEDBACK loop).
 *
 * GET  → { weeklySummary } — the current (fail-closed) consent state.
 * POST { weeklySummary: boolean } → set it. Default is OFF; turning it ON is the
 *        single consented exception to zero-silent-egress, and it must be an
 *        explicit user action (requireWriteAuth), disclosed on the toggle copy
 *        and in the security notice.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ weeklySummary: weeklySummaryConsent() });
}

export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.weeklySummary !== "boolean") {
    return Response.json({ error: "weeklySummary must be a boolean" }, { status: 400 });
  }

  setWeeklySummaryConsent(body.weeklySummary);
  return Response.json({ weeklySummary: weeklySummaryConsent() });
}
