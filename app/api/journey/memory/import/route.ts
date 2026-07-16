import { ingestFolder, scaffoldWiki } from "@/lib/memory-wiki";
import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST { path } -> bring in ONE folder the customer picked by hand. WRITE-gated.
 *
 * The path must be an explicit folder the customer chose. There is no discovery
 * and no whole-disk scanning: lib/memory-wiki.ts validateSourceFolder refuses
 * anything outside the home folder or matching a secret path, and the read is
 * bounded (file count, total bytes, per-file bytes, text-only, no hidden files).
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* validated below */
  }
  const folderPath = typeof body?.path === "string" ? body.path : "";
  if (!folderPath.trim()) {
    return Response.json({ error: "Pick a folder to bring in first." }, { status: 400 });
  }

  try {
    scaffoldWiki();
    const result = await ingestFolder(folderPath);
    if (!result.ok) {
      // A refusal (secret path, outside home, not a folder, no readable files)
      // is a client error the customer can act on, not a server fault.
      return Response.json({ error: result.reason ?? "I could not bring in that folder." }, { status: 400 });
    }
    appendJournal({
      ts: Date.now(),
      threadId: "memory",
      tool: "memory-import",
      summary: `${result.written} notes from ${result.source}`,
    });
    return Response.json(result);
  } catch {
    return Response.json(
      { error: "I could not bring in that folder just now. Please try again." },
      { status: 500 }
    );
  }
}
