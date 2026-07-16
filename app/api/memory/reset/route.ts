import { resetMemory, MemoryControlError } from "@/lib/memory-controls";
import { requireWriteAuth } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST { confirmPhrase } → fully reset Vidi's memory (recoverably: notes +
 * fleet memory are MOVED into a trash folder, never deleted). Requires the exact
 * confirm phrase; a wrong/missing phrase throws → 400. WRITE-gated
 * (requireWriteAuth): the highest-impact mutation in this surface.
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
  const confirmPhrase = typeof body.confirmPhrase === "string" ? body.confirmPhrase : "";
  try {
    const result = resetMemory({ confirmPhrase });
    appendJournal({
      ts: Date.now(),
      threadId: "memory",
      tool: "memory-reset",
      summary: `moved to ${result.trashDir}`,
    });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const status = e instanceof MemoryControlError ? e.status : 400;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
