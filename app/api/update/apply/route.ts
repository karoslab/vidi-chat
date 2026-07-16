import { requireWriteAuth } from "@/lib/origin";
import { startUpdate } from "@/lib/updater";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/update/apply → kicks off the update and returns immediately
 * ({ started } — 202) so the client can poll GET /api/update/status. A second
 * call while one is already running returns { started:false } with 409.
 *
 * Write-gated (session/control only — the phone token is excluded automatically
 * by requireWriteAuth, and the tool-originated agent fetch never carries the
 * session token), matching /api/builder-mode. This is deliberately the most
 * dangerous capability in the app (it replaces the running code), so it demands
 * the same positive credential as act-mode. No body required.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const result = startUpdate();
  return Response.json(result, { status: result.started ? 202 : 409 });
}
