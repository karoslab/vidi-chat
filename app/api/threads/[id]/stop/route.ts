import { NextRequest } from "next/server";
import { requireWriteAuth } from "@/lib/origin";
import { stopTurn } from "@/lib/turn-abort";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST /api/threads/[id]/stop → abort the turn currently running on this
 * thread, if any (the explicit stop button). The CLI child is killed
 * (claude.ts/codex.ts's onAbort) and the partial answer persists to the
 * thread as a normal assistant message flagged `stopped: true` — nothing is
 * silently dropped. { stopped: boolean } — false just means there was
 * nothing to stop (the turn already finished), not an error.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  return Response.json({ stopped: stopTurn(id) });
}
