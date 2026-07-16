import { requireWriteAuth, requireJsonContentType } from "@/lib/origin";
import { approve } from "@/lib/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * POST → approve (make live) one piece of work. Write surface — requireWriteAuth
 * + JSON content type. This is the CUSTOMER's designed merge chokepoint: it runs
 * `gh pr merge --squash` server-side (see lib/approvals.ts). The agent's own CLI
 * lane still cannot merge (ACT_DISALLOWED_TOOLS in lib/providers/claude.ts).
 * Every approve is journaled inside approve().
 */
export async function POST(req: Request) {
  const badType = requireJsonContentType(req);
  if (badType) return badType;
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;

  let ref: unknown;
  try {
    ({ ref } = await req.json());
  } catch {
    return Response.json({ error: "expected a JSON body with a work reference" }, { status: 400 });
  }
  if (typeof ref !== "string" || !ref.trim()) {
    return Response.json({ error: "which work? send its reference" }, { status: 400 });
  }

  const result = await approve(ref.trim());
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
