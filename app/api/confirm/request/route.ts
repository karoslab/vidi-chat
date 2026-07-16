import { NextRequest } from "next/server";
import { fileConfirm } from "@/lib/confirm";
import { appendJournal } from "@/lib/journal";
import { crossOriginResponse, requireJsonContentType, sameOriginOk } from "@/lib/origin";
import { verifyControlToken } from "@/lib/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm-request route — files a risky action into the one-slot confirm queue
 * (lib/confirm.ts) so Vidi can ask the owner "should I go ahead?" and only run it
 * after he says "confirm" on the next turn.
 *
 * POST { kind, payload, description } → { pendingId, description }
 *
 * `kind` must be one of the registry executors (hands / gws-email /
 * gws-calendar / write-file). `payload` is the data that kind's executor
 * reconstructs the action from; it persists to disk, so a confirm survives an
 * app restart. `description` is the human sentence Vidi speaks.
 *
 * Same-origin gated exactly like /api/history AND control-token gated (B1): the
 * native shim (bin/vidi-act) attaches x-vidi-control-token, so it and the Swift
 * app are allowed; a blind/tokenless local POST — the B1 forge that would park a
 * bogus action to trick an approval — is rejected. This route only PARKS an
 * action (it never runs one), and the returned per-command `nonce` is what the
 * trusted UI later presents to approve it (lib/confirm.ts). The 120s TTL and
 * depth-1 (newest replaces older) semantics come from lib/confirm.ts unchanged.
 */

const ALLOWED_KINDS = new Set([
  "hands",
  "gws-email",
  "gws-calendar",
  "write-file",
]);

export async function POST(req: NextRequest) {
  if (!sameOriginOk(req)) return crossOriginResponse();
  // B1: parking a risky action requires the control token — a blind local POST
  // (no token) can't file an action to later coax an approval out of the user.
  if (!verifyControlToken(req)) {
    return Response.json({ error: "invalid or missing control token" }, { status: 401 });
  }
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (!ALLOWED_KINDS.has(kind)) {
    return Response.json(
      { error: `unknown confirm kind: ${kind || "(none)"}` },
      { status: 400 }
    );
  }
  if (!description) {
    return Response.json({ error: "description required" }, { status: 400 });
  }

  const { pendingId, nonce } = fileConfirm({
    kind,
    payload: body.payload ?? null,
    description,
  });

  // Provenance: a risky action was PARKED (not run). The confirm/cancel turn
  // journals the run/cancel separately.
  try {
    appendJournal({
      ts: Date.now(),
      threadId: "confirm",
      tool: `confirm-filed:${kind}`,
      summary: `${description} (${pendingId})`,
    });
  } catch {
    /* journaling must never break the request */
  }

  // `nonce` is the per-command approval secret the trusted UI carries back to
  // approve this exact action (B1 Layer A). It is machine-side only (O1), never
  // spoken to the user.
  return Response.json({ pendingId, description, nonce });
}
