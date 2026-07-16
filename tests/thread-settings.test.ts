import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelValidForProvider } from "../lib/thread-settings.ts";

/**
 * PATCH /api/threads/[id] model validation (R3). The route used to gate every
 * model against a single static whitelist {auto,fable,opus,sonnet,default},
 * which 400'd real grok/codex model ids — so switching a grok or codex thread's
 * model over PATCH silently failed. Validation is now per the thread's own
 * provider (this helper), which the route calls.
 */

test("claude accepts its router ids + the legacy fable pin", () => {
  assert.ok(isModelValidForProvider("claude", "auto"));
  assert.ok(isModelValidForProvider("claude", "opus"));
  assert.ok(isModelValidForProvider("claude", "sonnet"));
  assert.ok(isModelValidForProvider("claude", "fable")); // legacy, degrades to opus+ultracode
});

test("grok accepts the Chat/Build ids + the legacy grok-4.5 (FIX 3)", () => {
  assert.ok(isModelValidForProvider("grok", "grok-4.5-build"));
  assert.ok(isModelValidForProvider("grok", "grok-4.5-chat"));
  // Legacy bare id stays PATCH-able for grok (coerces to Build in the provider).
  assert.ok(isModelValidForProvider("grok", "grok-4.5"));
  assert.ok(!isModelValidForProvider("grok", "grok-composer-2.5-fast")); // not offered
});

test("codex accepts default + the four GPT-5.x slugs", () => {
  for (const m of ["default", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
    assert.ok(isModelValidForProvider("codex", m), `codex should accept ${m}`);
  }
});

test("a model from the wrong provider is rejected", () => {
  assert.ok(!isModelValidForProvider("claude", "grok-4.5"));
  assert.ok(!isModelValidForProvider("grok", "opus"));
  assert.ok(!isModelValidForProvider("codex", "grok-4.5"));
});

test("unknown provider, unknown model, and non-strings are rejected", () => {
  assert.ok(!isModelValidForProvider("nope", "opus"));
  assert.ok(!isModelValidForProvider("codex", "gpt-9"));
  assert.ok(!isModelValidForProvider("claude", undefined));
  assert.ok(!isModelValidForProvider("claude", 42));
});
