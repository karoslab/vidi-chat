import { test } from "node:test";
import assert from "node:assert/strict";

import { plainLanguageProviderError } from "../lib/provider-error.ts";

/**
 * T1.4 — error boundary. A raw provider/CLI error message must never reach the
 * UI or TTS verbatim: the classifier maps each known failure class to a calm,
 * human sentence and falls back to a generic line for anything else. The load-
 * bearing property: the output NEVER contains CLI internals.
 */

test("a raw 'claude CLI error: …' becomes a generic friendly line, no CLI detail", () => {
  const raw = "claude CLI error: TypeError: cannot read properties of undefined at /Users/x/foo.ts:42";
  const friendly = plainLanguageProviderError(raw);
  assert.ok(!friendly.toLowerCase().includes("cli"));
  assert.ok(!friendly.includes("/Users/"));
  assert.ok(!friendly.toLowerCase().includes("typeerror"));
  assert.ok(friendly.length > 0);
});

test("usage-limit errors surface an actionable, plain message", () => {
  const friendly = plainLanguageProviderError(
    "claude CLI error: every configured account has reached its usage limit. Run /usage-credits or wait."
  );
  assert.ok(/usage limit/i.test(friendly));
  assert.ok(!friendly.includes("/usage-credits")); // no CLI command echoed
});

test("not-logged-in errors point the user to sign in, without CLI flags or the retired Helper menu", () => {
  const friendly = plainLanguageProviderError(
    "claude CLI error: no configured account is logged in (work: not logged in — run /login under …)"
  );
  assert.ok(/sign(ed)? in/i.test(friendly));
  assert.ok(!friendly.includes("/login"));
  // The Helper "Connect AI provider" menu row was removed (launcher PR #12) —
  // never send a customer there. The in-app Setup step is the connect path now.
  assert.ok(!/Vidi Helper/.test(friendly));
  assert.ok(!/Connect AI provider/.test(friendly));
});

test("a spawn failure becomes a try-again line, no ENOENT/paths", () => {
  const friendly = plainLanguageProviderError("failed to spawn claude CLI: ENOENT /usr/local/bin/claude");
  assert.ok(!friendly.toLowerCase().includes("enoent"));
  assert.ok(!friendly.includes("/usr/local"));
  assert.ok(friendly.length > 0);
});

test("an aborted/killed run becomes a plain timeout line", () => {
  const friendly = plainLanguageProviderError("claude CLI produced no output for 5 minutes — killed.");
  assert.ok(friendly.length > 0);
  assert.ok(!friendly.toLowerCase().includes("cli"));
});

test("empty / null input still yields a friendly generic message", () => {
  assert.ok(plainLanguageProviderError("").length > 0);
  assert.ok(plainLanguageProviderError(null).length > 0);
  assert.ok(plainLanguageProviderError(undefined).length > 0);
});
