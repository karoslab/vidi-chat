/**
 * Chat-native feedback intent (DIAGNOSTICS + FEEDBACK loop, 2026-07-11).
 *
 * A lightweight, MECHANICAL matcher (prefix/regex, NOT a model call) so a typed
 * message like "tell the owner the buttons are too small" or "send feedback: love
 * the new voice" surfaces a suggestion chip that opens the compose-with-preview
 * flow, prefilled. It NEVER sends — the compose screen is the only send surface.
 * A miss falls through to a normal chat turn (the matcher never guesses).
 *
 * Anchored on the WHOLE message start (after trim/lowercase), mirroring the
 * lib/fixit-intents.ts discipline: a mid-sentence "tell the owner" inside a longer
 * request does not fire.
 */

export interface FeedbackIntent {
  kind: "feedback";
  /** The message text with the trigger phrase stripped — prefills the compose
   *  box. Empty string when the user only typed the trigger. */
  body: string;
}

/**
 * Trigger phrases, longest/most-specific first so "send feedback" wins over a
 * hypothetical "send". Each is matched only at the very start of the message.
 */
const TRIGGERS = [
  "send feedback to the owner",
  "give feedback to the owner",
  "send the owner feedback",
  "tell the owner that",
  "tell the owner",
  "message the owner",
  "send feedback",
  "give feedback",
  "report a bug",
  "report bug",
  "feedback:",
  "feedback -",
];

/**
 * Match a typed message against the feedback grammar. Returns the intent (with
 * the remaining text as the prefill body) or null. Punctuation/colon/comma right
 * after the trigger is consumed so "feedback: hi" → body "hi".
 */
export function matchFeedbackIntent(message: string): FeedbackIntent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const trigger of TRIGGERS) {
    if (lower === trigger || lower.startsWith(trigger + " ") || lower.startsWith(trigger + ",") || lower.startsWith(trigger + ":")) {
      // Strip the trigger from the ORIGINAL (preserve the user's casing in the
      // body), then drop a leading separator/filler.
      let body = trimmed.slice(trigger.length);
      body = body.replace(/^[\s:,\-]+/, "");
      body = body.replace(/^(that|about|regarding)\s+/i, "");
      return { kind: "feedback", body: body.trim() };
    }
  }
  return null;
}
