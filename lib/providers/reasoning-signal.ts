/**
 * Honest reasoning-signal detection for the claude CLI stream — pure and
 * dependency-free so it's testable at this seam (claude.ts itself isn't
 * importable under `node --test` due to extensionless local imports).
 *
 * Verified against claude CLI 2.1.195: thinking TEXT is redacted (the
 * content_block.type=="thinking" block and its thinking_deltas are empty, plus
 * one opaque signature_delta), so we NEVER surface text. Two real signals do
 * survive and this module extracts only those:
 *   1. presence of a type=="thinking" content_block_start (boolean), and
 *   2. usage.output_tokens_details.thinking_tokens on the per-message
 *      message_delta stream_event (numeric). The final `result` event's usage
 *      has NO output_tokens_details, so the count must be read from message_delta.
 */

export interface ReasoningSignal {
  reasoned: boolean;
  tokens?: number;
}

/**
 * Fold one already-parsed CLI stream line into the running reasoning signal.
 * Returns the updated signal; only mutates it on a genuine reasoning event.
 */
export function foldReasoningSignal(
  prev: ReasoningSignal,
  evt: unknown
): ReasoningSignal {
  const e = evt as { type?: string; event?: any };
  if (e?.type !== "stream_event") return prev;
  const inner = e.event;
  if (
    inner?.type === "content_block_start" &&
    inner.content_block?.type === "thinking"
  ) {
    // Boolean: a thinking block was emitted. Its text is redacted (empty) on
    // this CLI — presence only, never the text.
    return { ...prev, reasoned: true };
  }
  if (inner?.type === "message_delta") {
    const tt = inner.usage?.output_tokens_details?.thinking_tokens;
    if (typeof tt === "number" && tt > 0) {
      return { reasoned: true, tokens: tt };
    }
  }
  return prev;
}
