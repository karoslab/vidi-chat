import { forgetNote, MemoryControlError } from "@/lib/memory-controls";
import { requireWriteAuth } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST { id } → forget one remembered note (deletes the note file inside the
 * jailed notes dir + fires a gbrain sync). WRITE-gated: this is an irreversible
 * mutation of the primary memory store, so requireWriteAuth ({session,control})
 * — the same gate every other mutation uses.
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
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    forgetNote(id);
  } catch (e) {
    const status = e instanceof MemoryControlError ? e.status : 400;
    return Response.json({ error: (e as Error).message }, { status });
  }
  appendJournal({ ts: Date.now(), threadId: "memory", tool: "memory-forgot", summary: id });
  return Response.json({ ok: true });
}
