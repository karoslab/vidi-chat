import { browserRailsEnabled, setBrowserRails } from "@/lib/browser-rails/config";
import { isOwner } from "@/lib/user-config";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser Rails opt-in (Phase 1, default OFF) — the in-app consent gate for the
 * browser-automation trust surface, modeled on /api/builder-mode. Turning it on
 * is an explicit user choice; the agent cannot call this route (write routes
 * demand the session token that tool-originated fetches never carry, and the
 * state file is on the SECRET_PATHS denylist so a tool-run Write can't flip it).
 *
 * GET  → { on, owner } (read-gated)
 * POST { on: boolean } → persist + echo (write-gated + JSON content type).
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ on: browserRailsEnabled(), owner: isOwner() });
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
  if (typeof body.on !== "boolean") {
    return Response.json({ error: "send { on: true | false }" }, { status: 400 });
  }
  setBrowserRails(body.on);
  return Response.json({ on: browserRailsEnabled(), owner: isOwner() });
}
