import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { requestChanges } from "@/lib/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST → ask for changes on one piece of work: comment the note on the PR and
 * seed a follow-up task for Vidi. Write surface — requireWriteAuth + JSON type.
 */
export async function POST(req: Request) {
  const badType = requireJsonContentType(req);
  if (badType) return badType;
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  let ref: unknown;
  let note: unknown;
  try {
    ({ ref, note } = await req.json());
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (typeof ref !== "string" || !ref.trim()) {
    return Response.json({ error: "which work? send its reference" }, { status: 400 });
  }
  if (typeof note !== "string" || !note.trim()) {
    return Response.json({ error: "tell Vidi what to change" }, { status: 400 });
  }

  const result = await requestChanges(ref.trim(), note);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
