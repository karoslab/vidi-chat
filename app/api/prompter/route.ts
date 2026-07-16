import { NextRequest } from "next/server";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";
import { deleteBrief, listBriefs } from "@/lib/prompter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → the customer's saved briefs (newest first). Read-gated. */
export async function GET(req: NextRequest) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ briefs: listBriefs() });
}

/** DELETE (via POST { action:"delete", slug }) → remove one saved plan.
 *  Write-gated + JSON content type, like every other state-changing route. */
export async function POST(req: NextRequest) {
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
  if (body.action !== "delete" || typeof body.slug !== "string") {
    return Response.json({ error: 'send { action: "delete", slug }' }, { status: 400 });
  }
  try {
    const removed = deleteBrief(body.slug);
    return Response.json({ ok: true, removed });
  } catch {
    return Response.json({ error: "could not delete that plan" }, { status: 400 });
  }
}
