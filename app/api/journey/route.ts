import { computeJourney, recheckStep } from "@/lib/journey/registry";
import { personaCopyDeep } from "@/lib/persona-copy";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Vidi Journey state.
 *
 * GET  → the full verified journey. Every step carries ok/fail/waiting with a
 *        plain-language reason, and currentStepId names the resume point. The
 *        position is recomputed on every call by running verify() down the
 *        registry — never read from the cache — so the customer can never get
 *        lost. Read-gated (session / control / phone).
 * POST { stepId, action:"recheck" } → re-verify one step and return its fresh
 *        state, for the "Check again" button after the customer fixes something.
 *        Write-gated (session / control) + JSON content type, matching every
 *        other state-touching route.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const state = await computeJourney();
  // The steps speak as the install's persona ("Anna is open and running").
  return Response.json(personaCopyDeep(state));
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

  if (body.action !== "recheck" || typeof body.stepId !== "string") {
    return Response.json(
      { error: 'send { stepId, action: "recheck" }' },
      { status: 400 }
    );
  }

  const step = await recheckStep(body.stepId);
  if (!step) return Response.json({ error: "unknown step" }, { status: 404 });
  return Response.json({ step: personaCopyDeep(step) });
}
