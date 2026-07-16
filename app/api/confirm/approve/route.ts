import { NextRequest } from "next/server";
import { confirmPending } from "@/lib/confirm";
import { bumpDiagUsage } from "@/lib/diag-ledger";
import {
  crossOriginResponse,
  requireJsonContentType,
  requireWriteAuth,
  sameOriginOk,
} from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { nonce } → { ran, text }
 *
 * The browser confirm card's Approve button. It carries back the per-command
 * nonce the card read from GET /api/confirm/pending, and runs the parked action
 * through the EXISTING confirmPending unchanged — same nonce gate, TTL,
 * plan-mutation invalidation, single-use property, and payload redaction the
 * voice/Swift path already relies on. A wrong / expired / plan-mutated nonce
 * returns { ran: false } WITHOUT burning the slot (confirmPending's contract),
 * so a browser poll that raced a plan mutation fails closed. confirmPending
 * itself journals confirm-executed / confirm-failed.
 *
 * Gate: sameOriginOk (CSRF, 403 cross-origin) + requireWriteAuth (positive
 * session/control token, excludes the read-only phone token; satisfies the
 * write-route-wiring audit's WRITE_GATE_RE). Approving is a capability grant —
 * it fires a consequential action — so it sits on the write gate, not the read
 * one, exactly like every other mutating route.
 */
export async function POST(req: NextRequest) {
  if (!sameOriginOk(req)) return crossOriginResponse();
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const nonce =
    body && typeof body === "object" && typeof (body as { nonce?: unknown }).nonce === "string"
      ? (body as { nonce: string }).nonce
      : "";

  const { ran, text } = await confirmPending(Date.now(), { nonce });
  if (ran) bumpDiagUsage("desk.approvals"); // weekly-summary usage count, no content
  return Response.json({ ran, text });
}
