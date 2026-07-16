import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFeedbackIntent } from "../lib/feedback-intent.ts";

/** Chat-native feedback intent: mechanical prefix match, body extraction, and
 *  the misses that must fall through to a normal chat turn. */

test("matches trigger phrases and extracts the body (preserving casing)", () => {
  assert.deepEqual(matchFeedbackIntent("tell the owner the buttons are too small"), {
    kind: "feedback",
    body: "the buttons are too small",
  });
  assert.deepEqual(matchFeedbackIntent("feedback: love the new voice"), {
    kind: "feedback",
    body: "love the new voice",
  });
  assert.deepEqual(matchFeedbackIntent("send feedback about the slow startup"), {
    kind: "feedback",
    body: "the slow startup",
  });
  assert.deepEqual(matchFeedbackIntent("tell the owner that it crashed twice"), {
    kind: "feedback",
    body: "it crashed twice",
  });
});

test("bare trigger yields an empty body", () => {
  assert.deepEqual(matchFeedbackIntent("send feedback"), { kind: "feedback", body: "" });
});

test("misses fall through (null) for normal messages and mid-sentence mentions", () => {
  assert.equal(matchFeedbackIntent("what did you tell the owner yesterday?"), null);
  assert.equal(matchFeedbackIntent("summarize the feedback in this doc"), null);
  assert.equal(matchFeedbackIntent("open the deploy dashboard"), null);
  assert.equal(matchFeedbackIntent(""), null);
});
