import { NextRequest } from "next/server";
import { close, prompt } from "@/lib/agents/manager";
import { requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { text } → queue a turn on this agent (runs in the background). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // P8 finding 3 follow-up: prompting a spawned agent drives more act-mode
  // work — same requireWriteAuth gate as the spawn route. The browser Canvas
  // UI already carries the session token via the layout fetch-shim.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* validated below */
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  const res = prompt(id, text);
  if (!res.ok) {
    return Response.json({ error: res.reason, agent: res.agent }, { status: 409 });
  }
  return Response.json({ ok: true, agent: res.agent });
}

/** DELETE → abort any in-flight turn and remove the agent. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // P8 finding 3 follow-up: aborting/removing an agent is the same
  // write-capable surface as spawn/prompt above.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  return Response.json({ ok: close(id) });
}
