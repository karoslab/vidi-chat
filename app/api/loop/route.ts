import { startLoop } from "@/lib/loop";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start an autonomous loop. POST { goal, agentName?, url?, maxIterations? }.
 * Fire-and-forget: returns immediately; progress streams onto the agent's
 * card via the fleet SSE (/api/agents/events, shown on /canvas).
 */
export async function POST(req: Request) {
  // P8 finding 3: starting an autonomous act-mode loop is a write-capable
  // action — require a positive session/control token, not sameOriginOk alone.
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
  const res = startLoop({
    goal: typeof body.goal === "string" ? body.goal : "",
    agentName: typeof body.agentName === "string" ? body.agentName : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
  });
  return Response.json(res, { status: res.ok ? 200 : 409 });
}
