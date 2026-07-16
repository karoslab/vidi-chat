import { scaffoldWiki, verifyWiki } from "@/lib/memory-wiki";
import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { appendJournal } from "@/lib/journal";
import { homeRelative } from "@/lib/expand-tilde";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST -> create the customer's memory folder (idempotent) and return its state.
 * WRITE-gated: it makes folders, seeds a note, and initializes git.
 */
export async function POST(req: Request) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badType = requireJsonContentType(req);
  if (badType) return badType;
  try {
    const result = scaffoldWiki();
    // Display-only: never surface an absolute filesystem path to the customer.
    const root = homeRelative(result.root);
    appendJournal({ ts: Date.now(), threadId: "memory", tool: "memory-scaffold", summary: root });
    return Response.json({ ...result, root, verify: verifyWiki() });
  } catch {
    return Response.json(
      { error: "I could not set up your memory folder just now." },
      { status: 500 }
    );
  }
}
