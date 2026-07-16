import { actModeAllowed, isOwner, setBuilderMode } from "@/lib/user-config";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Builder mode (act-with-rails opt-in) — the in-app twin of the Vidi Helper
 * menu toggle (2026-07-12 customer ask: the switch belongs where the person
 * already is). Same consent, same rails: the write jail, secret denylist,
 * confirm gates, and git-push protection all still bind; VIDI_OWNER stays 0.
 *
 * GET  → { on, owner } (read-gated)
 * POST { on: boolean } → persist + echo (write-gated + JSON content type).
 *       The agent cannot call this: write routes demand the session token,
 *       which tool-originated fetches never carry, and the opt-in file itself
 *       is on the SECRET_PATHS denylist.
 */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ on: actModeAllowed(), owner: isOwner() });
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
  setBuilderMode(body.on);
  return Response.json({ on: actModeAllowed(), owner: isOwner() });
}
