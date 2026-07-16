import { listVisibleAgents, spawn } from "@/lib/agents/manager";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → { agents: AgentPublic[] } — token gated (Tier-2). Canvas-facing, so it
 *  returns ONLY user-initiated agents (origin chat/manual); background goal/
 *  system agents are excluded from the panes and the "N active" count. */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ agents: listVisibleAgents() });
}

/** POST { provider?, model?, name?, mode? } → spawn a fleet agent. */
export async function POST(req: Request) {
  // P8 finding 3 follow-up: spawning a fleet agent is itself an act-mode agent
  // start — the sharpest of the secondary write routes. requireWriteAuth over
  // sameOriginOk closes the forged-loopback-Host raw-TCP door here too. The
  // browser Canvas UI (fetch("/api/agents", {method:"POST"})) already carries
  // x-vidi-session-token via the layout fetch-shim.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }
  if (body.provider !== undefined && body.provider !== "claude" && body.provider !== "codex") {
    return Response.json({ error: `unknown provider: ${body.provider}` }, { status: 400 });
  }
  try {
    const agent = spawn({
      provider: body.provider,
      model: body.model,
      name: typeof body.name === "string" ? body.name : undefined,
      mode: body.mode === "chat" ? "chat" : undefined,
      // The Canvas +Spawn button — a user creating an agent by hand.
      origin: "manual",
    });
    return Response.json({ agent });
  } catch (e: any) {
    return Response.json({ error: e?.message || "spawn failed" }, { status: 409 });
  }
}
