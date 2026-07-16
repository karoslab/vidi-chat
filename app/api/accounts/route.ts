import { NextRequest } from "next/server";
import { loadAccounts, getActiveAccountId, setActiveAccountId } from "@/lib/accounts";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/** GET → the account registry (label only, no config dirs) + the active id.
 *  Token gated (Tier-2 fix-round finding 4): still an install-fingerprinting
 *  read, so not open over the tailnet. */
export function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json({
    accounts: loadAccounts().map((a) => ({
      id: a.id,
      label: a.label,
      disabled: a.disabled === true,
    })),
    activeId: getActiveAccountId(),
  });
}

/**
 * POST { id } → set the active account (server-side, applies to new turns).
 * P8 finding 3 follow-up (2nd re-review): switching the active account/config-
 * dir is a capability-relevant mutation every subsequent act-mode turn
 * inherits — require a positive session/control token, not sameOriginOk alone.
 * Sole caller is the browser (components/Chat.tsx), already carrying the
 * session token via the layout fetch-shim.
 */
export async function POST(req: NextRequest) {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!setActiveAccountId(id)) {
    return Response.json({ error: `unknown or disabled account: ${id}` }, { status: 400 });
  }
  return Response.json({ activeId: id });
}
