import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * FROZEN SSE CONTRACT for /api/voice-command — locked so any future wave that
 * breaks the shape the Swift menu-bar app depends on fails CI.
 *
 * The contract (route header comment, voice-command/route.ts):
 *   first:   data: {"type":"ack"}
 *   then 0+: data: {"type":"delta","text":"..."}
 *   final:   data: {"type":"result","text":"<complete answer>"}   (exactly one, terminal)
 *   ack carries {type}; delta carries {type, text}. The result carries
 *   {type, text} and MAY additionally carry `pendingConfirm: {description,
 *   nonce}` — the optional, control-token-gated B1 approval field (see the route
 *   header + tests/confirm-nonce-delivery.test.ts, which pins its gating). There
 *   is no error event. The base framing below reimplements the plain-result path
 *   only (no parked action, so no pendingConfirm) — it locks the ack/delta/result
 *   skeleton; the optional field's presence/absence is covered by the delivery
 *   test, not here.
 *
 * Why this shape and not a full route import: the route file (and runVoiceTurn)
 * use "@/" alias imports that plain `node --test` won't resolve (same reason
 * push-route.test.ts tests the pieces, not the handler). So we drive the route's
 * EXACT SSE framing — its `send`/ReadableStream construction, byte-for-byte —
 * against a stub runVoiceTurn that honors the real onAck/onDelta/return
 * protocol. The provider is mocked at that seam: no CLI is ever spawned. If the
 * route's framing OR runVoiceTurn's callback protocol drifts from this, the
 * parsed frames below stop matching and this test goes red.
 */

/** The exact framing the route uses (voice-command/route.ts). Kept identical
 *  on purpose — this IS the contract under test. */
function buildContractStream(
  runVoiceTurn: (
    transcript: string,
    opts: {
      onAck?: () => void;
      onDelta?: (text: string) => void;
      signal?: AbortSignal;
    }
  ) => Promise<string>,
  transcript: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  return new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* consumer gone */
        }
      };
      const finalText = await runVoiceTurn(transcript, {
        signal: abort.signal,
        onAck: () => send({ type: "ack" }),
        onDelta: (text) => send({ type: "delta", text }),
      });
      send({ type: "result", text: finalText });
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      abort.abort();
    },
  });
}

/** Drain an SSE ReadableStream into the parsed `data:` payload objects. */
async function collectFrames(stream: ReadableStream<Uint8Array>): Promise<any[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: any[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line ("\n\n").
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.trim();
      if (!line.startsWith("data:")) {
        assert.fail(`SSE frame must start with "data:" — got ${JSON.stringify(chunk)}`);
      }
      frames.push(JSON.parse(line.slice("data:".length).trim()));
    }
  }
  return frames;
}

/** Assert the full frozen contract over a parsed frame list. */
function assertContract(frames: any[]) {
  assert.ok(frames.length >= 2, "at least an ack and a result");

  // 1) First frame is EXACTLY {type:"ack"} — no text, no extra keys.
  assert.deepEqual(frames[0], { type: "ack" }, "first frame must be a bare ack");

  // 2) Exactly one terminal result, and it is the LAST frame.
  const resultIdxs = frames
    .map((f, i) => (f.type === "result" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(resultIdxs.length, 1, "exactly one result frame");
  assert.equal(resultIdxs[0], frames.length - 1, "result is the terminal frame");

  // 3) Everything between ack and result is a delta (zero or more).
  for (let i = 1; i < frames.length - 1; i++) {
    assert.equal(frames[i].type, "delta", `frame ${i} between ack and result must be a delta`);
  }

  // 4) No error event exists in the contract.
  assert.ok(!frames.some((f) => f.type === "error"), "there is no error event in the contract");

  // 5) Base-framing field shape: ack={type}; delta/result={type,text:string}.
  //    (The plain-result path is under test here — a real turn may add the
  //    optional gated `pendingConfirm` to a result; that field is covered by
  //    tests/confirm-nonce-delivery.test.ts, not this framing skeleton.)
  for (const f of frames) {
    const keys = Object.keys(f).sort();
    if (f.type === "ack") {
      assert.deepEqual(keys, ["type"], "ack carries only {type}");
    } else if (f.type === "delta" || f.type === "result") {
      assert.deepEqual(keys, ["text", "type"], `${f.type} carries exactly {type, text}`);
      assert.equal(typeof f.text, "string", `${f.type}.text is a string`);
    } else {
      assert.fail(`unexpected frame type ${JSON.stringify(f.type)}`);
    }
  }
}

test("SSE contract: ack → delta* → single terminal result (streaming turn)", async () => {
  // Mock the provider seam: a runVoiceTurn that streams three deltas then
  // resolves the assembled result — the ordinary long-answer path.
  const fakeRunVoiceTurn = async (
    _t: string,
    opts: { onAck?: () => void; onDelta?: (t: string) => void }
  ) => {
    opts.onAck?.();
    opts.onDelta?.("Hel");
    opts.onDelta?.("lo, ");
    opts.onDelta?.("world.");
    return "Hello, world.";
  };
  const frames = await collectFrames(buildContractStream(fakeRunVoiceTurn, "say hi"));
  assertContract(frames);
  assert.deepEqual(frames, [
    { type: "ack" },
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo, " },
    { type: "delta", text: "world." },
    { type: "result", text: "Hello, world." },
  ]);
});

test("SSE contract: zero deltas is valid (synchronous intercept: ack → result)", async () => {
  // Kill-switch / confirm / fleet replies fire onAck then resolve with no
  // deltas. The contract must still hold: ack then exactly one result.
  const fakeSyncTurn = async (_t: string, opts: { onAck?: () => void }) => {
    opts.onAck?.();
    return "Kill switch cleared. I'm back.";
  };
  const frames = await collectFrames(buildContractStream(fakeSyncTurn, "clear the kill switch"));
  assertContract(frames);
  assert.deepEqual(frames, [
    { type: "ack" },
    { type: "result", text: "Kill switch cleared. I'm back." },
  ]);
});

test("SSE contract: a failure is delivered AS result text, never as an error event", async () => {
  // runVoiceTurn is fail-open: internal errors come back as speakable result
  // text. The route must surface that as a normal result, not an error frame.
  const fakeFailTurn = async (_t: string, opts: { onAck?: () => void }) => {
    opts.onAck?.();
    return "Something went wrong: internal error";
  };
  const frames = await collectFrames(buildContractStream(fakeFailTurn, "do a thing"));
  assertContract(frames);
  assert.equal(frames.at(-1).type, "result");
  assert.match(frames.at(-1).text, /Something went wrong/);
});
