import { test } from "node:test";
import assert from "node:assert/strict";
import { stepEyebrow, statusLabel, askVidiPrompt, stepHref } from "../lib/journey/ui.ts";

/**
 * StepFrame / SetupHealth contract, tested through the pure helpers the
 * components render from (the repo has no DOM test infra, so the load-bearing
 * logic lives in lib/journey/ui.ts and is unit-tested here). Pins the eyebrow
 * format, the status wording, the Ask Vidi pre-fill (context handed to chat),
 * and the shared deep-link convention.
 */

test("stepEyebrow renders 'Stage s · n of m'", () => {
  assert.equal(stepEyebrow(2, 2, 6), "Stage 2 · 2 of 6");
  assert.equal(stepEyebrow(1, 1, 3), "Stage 1 · 1 of 3");
});

test("statusLabel is plain and distinct per status", () => {
  const labels = [
    statusLabel("verified"),
    statusLabel("failed"),
    statusLabel("pending"),
    statusLabel("skipped"),
  ];
  for (const l of labels) assert.ok(l.length > 0);
  assert.equal(new Set(labels).size, 4);
  // No jargon leaks into the customer-facing label.
  for (const l of labels) assert.doesNotMatch(l.toLowerCase(), /repo|cli|token/);
});

test("askVidiPrompt hands the step title, the failure reason, and the step id to chat", () => {
  const prompt = askVidiPrompt({
    id: "claude-connected",
    title: "Vidi is connected to Claude",
    status: "failed",
    reason: "Vidi is not connected to Claude yet.",
  });
  assert.match(prompt, /Vidi is connected to Claude/); // the title
  assert.match(prompt, /not connected to Claude yet/); // the reason
  assert.match(prompt, /claude-connected/); // the id marker for troubleshooting
});

test("askVidiPrompt omits the reason line when the step is not failed", () => {
  const prompt = askVidiPrompt({ id: "vidi-running", title: "Vidi is open and running", status: "verified" });
  assert.doesNotMatch(prompt, /Vidi says:/);
  assert.match(prompt, /vidi-running/);
});

test("stepHref is the shared deep-link convention and encodes the id", () => {
  assert.equal(stepHref("claude-connected"), "/setup/step/claude-connected");
  assert.equal(stepHref("weird id"), "/setup/step/weird%20id");
});
