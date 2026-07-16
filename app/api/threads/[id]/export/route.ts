import { NextRequest } from "next/server";
import { getThread, threadToMarkdown, exportFilename } from "@/lib/store";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET /api/threads/[id]/export → text/markdown transcript (404 JSON if absent).
 *  Token gated (Tier-2): a full transcript export must not be an open tailnet read. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const thread = getThread(id);
  if (!thread) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(threadToMarkdown(thread), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(thread)}"`,
    },
  });
}
