import { correctNote, MemoryControlError } from "@/lib/memory-controls";
import { requireWriteAuth } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST { id, body } → correct one remembered note (rewrites the note file,
 * preserving its attribution footer + appending a "corrected on" line, then
 * fires a gbrain sync). WRITE-gated (requireWriteAuth): it mutates the primary
 * memory store.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* validation below */
  }
  const id = typeof body.id === "string" ? body.id : "";
  const newBody = typeof body.body === "string" ? body.body : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    correctNote(id, newBody);
  } catch (e) {
    const status = e instanceof MemoryControlError ? e.status : 400;
    return Response.json({ error: (e as Error).message }, { status });
  }
  appendJournal({ ts: Date.now(), threadId: "memory", tool: "memory-corrected", summary: id });
  return Response.json({ ok: true });
}
