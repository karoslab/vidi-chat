import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRetryWithoutResume } from "../lib/providers/claude-retry.ts";

/**
 * The stale-session retry decision (2026-07-05 incident: the the legacy workspace path →
 * workspace rename orphaned the voice thread's stored CLI session and every
 * turn died on --resume). Retry exactly when: resume was used, nothing was
 * streamed yet, and the failure looks like a dead session
 * (error_during_execution subtype or a "No conversation found" message).
 */

const base = {
  resumeUsed: true,
  emittedOutput: false,
  errorSubtype: null as string | null,
  errorDetail: "",
};

test("retries on error_during_execution when resuming (the incident shape)", () => {
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      errorSubtype: "error_during_execution",
      errorDetail: "No conversation found with session ID: 0b0e48a1",
    }),
    true
  );
});

test("retries on a session-not-found message even without the subtype", () => {
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      errorDetail: "Error: No conversation found with session ID: abc-123",
    }),
    true
  );
});

test("session-not-found match is case-insensitive (stderr-sourced detail)", () => {
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      errorDetail: "no conversation found with SESSION id: abc",
    }),
    true
  );
});

test("never retries when --resume was not used", () => {
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      resumeUsed: false,
      errorSubtype: "error_during_execution",
      errorDetail: "No conversation found with session ID: abc",
    }),
    false
  );
});

test("never retries after output was already streamed (would duplicate it)", () => {
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      emittedOutput: true,
      errorSubtype: "error_during_execution",
    }),
    false
  );
});

test("does not retry unrelated failures (other subtypes, exit codes, quota)", () => {
  assert.equal(
    shouldRetryWithoutResume({ ...base, errorSubtype: "error_max_turns" }),
    false
  );
  assert.equal(shouldRetryWithoutResume({ ...base, errorDetail: "exit code 1" }), false);
  assert.equal(
    shouldRetryWithoutResume({ ...base, errorDetail: "terminated by signal" }),
    false
  );
  assert.equal(
    shouldRetryWithoutResume({
      ...base,
      errorDetail: "Claude usage limit reached — resets at 5pm",
    }),
    false
  );
});
