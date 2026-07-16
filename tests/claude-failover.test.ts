import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLimitError,
  isLoginError,
  nextAccount,
  type AccountLite,
} from "../lib/providers/claude-failover.ts";

/**
 * Multi-account failover primitives. The full provider loop spawns the CLI and
 * isn't importable under `node --test` (extensionless imports in
 * providers/index.ts — see tests/agent-transitions.test.ts), so the two pure
 * decisions live in claude-failover.ts and are tested here in isolation:
 *   1. isLimitError — does this CLI failure look like a usage/Fable/credit cap
 *      (recoverable by another account) vs any other error (not recoverable).
 *   2. nextAccount — registry-order rotation, skipping already-tried accounts.
 */

test("isLimitError matches the exact Fable-5 CLI message from the incident", () => {
  assert.equal(
    isLimitError(
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    ),
    true
  );
});

test("isLimitError matches usage-limit / credits phrasings", () => {
  assert.equal(isLimitError("Claude usage limit reached — resets at 5pm"), true);
  assert.equal(isLimitError("You are out of message credits for this account"), true);
  assert.equal(isLimitError("Please visit /usage-credits"), true);
  assert.equal(isLimitError("you've REACHED YOUR weekly LIMIT"), true); // case-insensitive
});

test("isLimitError does NOT match unrelated failures", () => {
  assert.equal(isLimitError("No conversation found with session ID: abc"), false);
  assert.equal(isLimitError("Not logged in · Please run /login"), false);
  assert.equal(isLimitError("exit code 1"), false);
  assert.equal(isLimitError("terminated by signal"), false);
  assert.equal(isLimitError(""), false);
  assert.equal(isLimitError(null), false);
  assert.equal(isLimitError(undefined), false);
});

test("isLoginError matches the exact not-logged-in CLI message from the 2026-07-05 incident", () => {
  assert.equal(isLoginError("Not logged in · Please run /login"), true);
});

test("isLoginError matches other dead-credential phrasings", () => {
  assert.equal(isLoginError("Invalid API key · Please run /login"), true);
  assert.equal(isLoginError("OAuth token revoked"), true);
  assert.equal(isLoginError("oauth token expired — reauthenticate"), true);
});

test("isLoginError matches the org-disabled-subscription CLI message from the 2026-07-09 incident", () => {
  // Live failure: main's stale CLI credentials surfaced as this message and the
  // voice turn died WITHOUT rotating to the healthy alt account — it must
  // classify as login-class (skip the account, never persist it as active).
  assert.equal(
    isLoginError(
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access"
    ),
    true
  );
});

test("isLoginError does NOT match limits or unrelated failures", () => {
  assert.equal(isLoginError("You've reached your Fable 5 limit."), false);
  assert.equal(isLoginError("No conversation found with session ID: abc"), false);
  assert.equal(isLoginError("exit code 1"), false);
  assert.equal(isLoginError(""), false);
  assert.equal(isLoginError(null), false);
  assert.equal(isLoginError(undefined), false);
});

test("isLimitError and isLoginError are disjoint on both incident messages", () => {
  const limitMsg =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
  const loginMsg = "Not logged in · Please run /login";
  assert.equal(isLimitError(limitMsg) && isLoginError(limitMsg), false);
  assert.equal(isLimitError(loginMsg) && isLoginError(loginMsg), false);
});

const registry: AccountLite[] = [
  { id: "main", label: "Main (owner-account)" },
  { id: "alt", label: "Alt account" },
];

test("nextAccount returns the first untried account in registry order", () => {
  assert.deepEqual(nextAccount(registry, new Set()), registry[0]);
  assert.deepEqual(nextAccount(registry, new Set(["main"])), registry[1]);
});

test("nextAccount returns null once every account has been tried", () => {
  assert.equal(nextAccount(registry, new Set(["main", "alt"])), null);
});

test("nextAccount skips the failed account and honors registry order", () => {
  const three: AccountLite[] = [...registry, { id: "third", label: "Third" }];
  // main tried → next is alt; main+alt tried → next is third.
  assert.equal(nextAccount(three, new Set(["main"]))?.id, "alt");
  assert.equal(nextAccount(three, new Set(["main", "alt"]))?.id, "third");
});
