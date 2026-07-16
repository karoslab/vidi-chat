import { test } from "node:test";
import assert from "node:assert/strict";

import { foldReasoningSignal } from "../lib/providers/reasoning-signal.ts";

/**
 * Reasoning indicator — honest, non-text signal only.
 *
 * The claude CLI (2.1.195) redacts thinking TEXT: the type=="thinking"
 * content_block and its thinking_deltas are empty, and the only text-shaped
 * thing is an opaque signature_delta. So we assert on the two signals that DO
 * survive — the boolean presence of the thinking content_block, and the numeric
 * usage.output_tokens_details.thinking_tokens carried ONLY on the per-message
 * message_delta stream_event (the final `result` event drops it). Streams below
 * mirror the discovery evidence field-for-field.
 */

function fold(stream: unknown[]) {
  return stream.reduce(
    (sig: { reasoned: boolean; tokens?: number }, evt) =>
      foldReasoningSignal(sig, evt),
    { reasoned: false } as { reasoned: boolean; tokens?: number }
  );
}

// Reasoning turn (opus, --effort high, --permission-mode plan): a thinking
// content_block with empty text, empty thinking_deltas, then a message_delta
// whose usage.output_tokens_details.thinking_tokens is 236.
const REASONING_STREAM: unknown[] = [
  { type: "system", subtype: "init", session_id: "s" },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "The default is rollback journal." },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 4603,
        output_tokens: 1915,
        output_tokens_details: { thinking_tokens: 236 },
      },
    },
  },
  // The final result event has NO output_tokens_details — proves we can't rely
  // on it for the count, and that folding it changes nothing.
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 4603, output_tokens: 1915 },
  },
];

// Control turn (sonnet, --effort low, trivial prompt): no thinking block at all,
// only a text block, and message_delta thinking_tokens is 0.
const CONTROL_STREAM: unknown[] = [
  { type: "system", subtype: "init", session_id: "s2" },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "4" },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
  },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 3, output_tokens: 4 },
  },
];

test("emits the reasoning signal with the real thinking_tokens count for a reasoning stream", () => {
  const sig = fold(REASONING_STREAM);
  assert.equal(sig.reasoned, true);
  assert.equal(sig.tokens, 236);
});

test("does NOT emit the reasoning signal for a plain text-only stream", () => {
  const sig = fold(CONTROL_STREAM);
  assert.equal(sig.reasoned, false);
  assert.equal(sig.tokens, undefined);
});

test("boolean-only fallback: thinking content_block present but no numeric count", () => {
  // A thinking block with no message_delta count still counts as reasoned,
  // token count simply absent (the honest boolean-only fallback path).
  const sig = fold([
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "thinking", thinking: "", signature: "sig" },
      },
    },
  ]);
  assert.equal(sig.reasoned, true);
  assert.equal(sig.tokens, undefined);
});

test("thinking_tokens of 0 on message_delta is not treated as reasoning", () => {
  const sig = fold([
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: { output_tokens_details: { thinking_tokens: 0 } },
      },
    },
  ]);
  assert.equal(sig.reasoned, false);
});
