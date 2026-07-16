import { NAME_STACKS } from "@/lib/agent-names";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → { stacks } — the curated agent-name stacks for the spawn picker.
 *  Token gated (Tier-2) for consistency with the rest of the read surface. */
export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({ stacks: NAME_STACKS });
}
