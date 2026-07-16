import { NextRequest } from "next/server";
import { requireJsonContentType, requireWriteAuth } from "@/lib/origin";
import { runVoiceTurn } from "@/lib/voice-turn";
import { verifyControlToken } from "@/lib/control";
import { pendingApproval } from "@/lib/confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Voice command endpoint — FIXED CONTRACT, the menu-bar app consumes this.
 *
 * POST { "transcript": string, "mode"?, "model"?, "effort"?, "nonce"? } → SSE
 * events, exactly:
 *   first:   data: {"type":"ack"}
 *   then 0+: data: {"type":"delta","text":"..."}
 *   final:   data: {"type":"result","text":"<complete answer>"}
 *
 * The result event MAY additionally carry `pendingConfirm: {description, nonce}`
 * when this turn parked a risky action AND the request was control-authorized —
 * the B1 nonce the trusted UI carries back to approve it (see below). A consumer
 * that only reads {type,text} is unaffected.
 *
 * There is no error event in the contract: failures are delivered as the
 * `result` text so the consumer always gets something speakable.
 *
 * The turn itself runs in lib/voice-turn.ts (runVoiceTurn) — the SAME brain the
 * phone route (/api/phone/ask) uses, on the SAME persistent "voice" thread.
 * This route's only job is to wrap that turn in the frozen SSE contract:
 * runVoiceTurn's onAck fires the single `ack`, onDelta streams tokens, and its
 * resolved value is the final `result` text (already stripped of control/commit
 * markers). Synchronous intercepts (kill switch, confirm/cancel, fleet
 * commands) fire onAck then resolve with zero deltas — the contract is
 * ack → result, which the app already handles.
 */

export async function POST(req: NextRequest) {
  // P8 finding 3 (P7 re-audit follow-up): `mode` in the body can be "act", and
  // controlAuthorized below only gates confirm-approval/nonce delivery — NOT
  // whether the act turn itself runs. On the owner install (VIDI_OWNER=1,
  // defaultVoiceMode "auto"), sameOriginOk() ALONE let a tokenless POST with a
  // forged loopback Host drive a full act-mode turn (allowlisted Bash, jailed
  // Write) — the exact forged-Host raw-TCP RCE finding 3 was meant to close, via
  // a different route. requireWriteAuth demands a positive session/control
  // token a remote tailnet peer cannot read off this machine's disk. The Swift
  // menu-bar app must attach x-vidi-control-token (it already reads
  // data/control-token, like bin/vidi-act); until then this route pauses for
  // that caller — see PR body.
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
  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return Response.json({ error: "transcript required" }, { status: 400 });
  }

  // B1: an approval of a parked action ("confirm") only counts when this request
  // carries a valid control token (Layer B) AND the per-command nonce (Layer A) —
  // both attached machine-side by the owner's Swift app, never by a blind local
  // POST. verifyControlToken is a no-op cost for every other transcript. The nonce
  // rides in the body ({ nonce }); the confirm intercept in runVoiceTurn enforces
  // both. Same-origin is already checked above; this is the additive B1 gate.
  const controlAuthorized = verifyControlToken(req);
  const approvalNonce = typeof body.nonce === "string" ? body.nonce : undefined;

  const encoder = new TextEncoder();
  // Consumer disconnect (menu-bar app died mid-turn) aborts the CLI child.
  const abort = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* consumer gone — cancel() is aborting the run */
        }
      };

      // runVoiceTurn drives the exact contract: exactly one ack (onAck), then
      // zero-or-more deltas (onDelta), then one result (the resolved value).
      // It never throws — a failure resolves as speakable result text — so we
      // don't need a catch that could break the ack/result invariant.
      //
      // DESIGN NOTE (frozen-UI gap, flagged 2026-07-07 — future wave):
      // onDelta only fires on TEXT deltas. During long tool calls or extended
      // thinking the model emits no text for many seconds (a deep turn can run
      // minutes), so between `ack` and the first `delta` the app shows nothing
      // and looks frozen. Relaying activity (a "thinking…/running <tool>" pulse)
      // needs a new SSE event type AND Swift-side rendering of it — out of scope
      // here; deferred to a future wave. Don't widen the {type,text} contract
      // without the paired Swift change.
      const finalText = await runVoiceTurn(transcript, {
        mode: body.mode,
        model: body.model,
        effort: body.effort,
        signal: abort.signal,
        controlAuthorized,
        approvalNonce,
        onAck: () => send({ type: "ack" }),
        onDelta: (text) => send({ type: "delta", text }),
      });

      // B1 nonce delivery (O1 tap-to-approve): if this turn PARKED a risky
      // action, hand its per-command nonce back to the app ON the result event,
      // so the Swift overlay can render a "Do it" button (and a later spoken
      // "confirm") that carries the nonce + control token. STRICTLY gated on
      // controlAuthorized — the nonce is machine-side only, so a tokenless/blind
      // caller (the B1 forge) gets the spoken text but NEVER the nonce. Adding a
      // field to the result event is backward-compatible: a consumer that only
      // reads {type,text} is unaffected. `nonce` is intentionally the raw secret
      // here because verifyControlToken already proved the trusted app.
      const pending = controlAuthorized ? pendingApproval() : null;
      send(
        pending
          ? {
              type: "result",
              text: finalText,
              pendingConfirm: { description: pending.description, nonce: pending.nonce },
            }
          : { type: "result", text: finalText }
      );
      // No automatic Discord ping of responses — the owner's explicit ask
      // (2026-07-02): Vidi only posts to Discord when told to.
      try {
        controller.close();
      } catch {
        /* already closed by cancel() */
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
