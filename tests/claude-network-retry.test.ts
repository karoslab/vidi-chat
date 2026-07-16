import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNetworkError,
  shouldRetryNetwork,
  FRIENDLY_NETWORK_MESSAGE,
} from "../lib/providers/claude-network.ts";

/**
 * Friendly connection errors in chat (Phase B, item 4).
 *
 * The claude provider surfaces raw CLI connectivity failures verbatim into a
 * chat turn. Phase B (a) silently retries ONCE when the failure is
 * network-class AND nothing streamed yet, and (b) otherwise shows a plain,
 * persona-voiced line instead of the raw string. These are the pure decision
 * functions the provider uses; the retry-vs-not and never-double-apply rules
 * are asserted here without spawning the CLI.
 */

test("isNetworkError matches the CLI's raw connectivity strings", () => {
  for (const s of [
    "Connection problem. Check your internet connection, VPN, or proxy and try again.",
    "fetch failed",
    "request to https://api.anthropic.com failed, reason: getaddrinfo ENOTFOUND api.anthropic.com",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:443",
    "socket hang up",
    "connect ETIMEDOUT",
    "network is unreachable",
    "connection timed out",
    "EAI_AGAIN api.anthropic.com",
  ]) {
    assert.equal(isNetworkError(s), true, `should classify as network: ${s}`);
  }
});

test("isNetworkError does NOT swallow usage-limit or login failures", () => {
  // These have their OWN recovery (account rotation) — must not be treated as
  // network-retryable, or the failover driver would misroute them.
  for (const s of [
    "You've reached your Fable 5 limit. Run /usage-credits to continue.",
    "Not logged in · Please run /login",
    "invalid api key",
    "error_during_execution",
    "No conversation found with session ID abc",
    "some unrelated model error",
  ]) {
    assert.equal(isNetworkError(s), false, `should NOT be network: ${s}`);
  }
});

test("isNetworkError is null/undefined safe", () => {
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError(undefined), false);
  assert.equal(isNetworkError(""), false);
});

test("shouldRetryNetwork: a clean network failure is retried once", () => {
  assert.equal(
    shouldRetryNetwork({
      errorDetail: "Connection problem. Check your internet connection.",
      emittedOutput: false,
      alreadyRetried: false,
    }),
    true
  );
});

test("shouldRetryNetwork: a partially-streamed turn is NEVER retried", () => {
  // Retrying after text streamed would double-apply the turn (spoken/journaled
  // twice) — the same guard the stale-session retry uses.
  assert.equal(
    shouldRetryNetwork({
      errorDetail: "socket hang up",
      emittedOutput: true,
      alreadyRetried: false,
    }),
    false
  );
});

test("shouldRetryNetwork: the one retry is spent only once", () => {
  assert.equal(
    shouldRetryNetwork({
      errorDetail: "ECONNRESET",
      emittedOutput: false,
      alreadyRetried: true,
    }),
    false
  );
});

test("shouldRetryNetwork: non-network errors are not retried on this path", () => {
  assert.equal(
    shouldRetryNetwork({
      errorDetail: "You've reached your usage limit",
      emittedOutput: false,
      alreadyRetried: false,
    }),
    false
  );
});

test("the friendly message is plain, first-person, and dash-free", () => {
  assert.match(FRIENDLY_NETWORK_MESSAGE, /reach my brain/i);
  assert.doesNotMatch(FRIENDLY_NETWORK_MESSAGE, /[—–]/); // no em/en dashes
  // It must NOT leak a raw error token.
  assert.doesNotMatch(FRIENDLY_NETWORK_MESSAGE, /ECONN|ENOTFOUND|fetch failed/i);
});
