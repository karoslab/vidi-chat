import {
  DEFERRED_STEP_META,
  clearDeferredSteps,
  deferStep,
  readDeferredSteps,
  resolveStep,
} from "@/lib/deferred-onboarding";
import { requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Deferred-onboarding checklist backend (T2.4). Skipped steps persist here and
 * SettingsPanel surfaces them as a "finish setting up" section.
 *
 * GET  → { steps: DeferrableStep[], meta } — the current checklist + its copy.
 * POST { action: "defer"|"resolve"|"clear", step? } → mutate the checklist.
 *        Same-origin guarded like every state-changing route.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ steps: readDeferredSteps(), meta: DEFERRED_STEP_META });
}

export async function POST(req: Request) {
  // P8 finding 3 follow-up: mutating the deferred-onboarding checklist state,
  // matching the GET's requireReadAuth gate.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const step = typeof body.step === "string" ? body.step : "";
  let steps;
  switch (body.action) {
    case "defer":
      steps = deferStep(step);
      break;
    case "resolve":
      steps = resolveStep(step);
      break;
    case "clear":
      steps = clearDeferredSteps();
      break;
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
  return Response.json({ steps });
}
