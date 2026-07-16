import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated data dir per the agents.test.ts pattern (importing the manager
// touches data/). The provider chain (providers/index.ts, extensionless
// "./claude" imports) is NOT reachable under `node --test`, but fleetErrorReport
// is pure and needs none of it — see tests/agent-transitions.test.ts.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-agents-err-")));

const { fleetErrorReport } = await import("../lib/agents/manager.ts");
const { plainLanguageProviderError } = await import("../lib/provider-error.ts");

/**
 * F3 — the fleet manager forwarded raw provider stderr ("claude CLI error:
 * <500 chars stderr>") straight into the origin chat message and the Canvas
 * feed. fleetErrorReport is the shared boundary both error sites now use: it
 * classifies the raw message through plainLanguageProviderError so the chat/feed
 * text carries a friendly line and NO stderr/paths/flags — while keeping the
 * agent name.
 */
test("fleetErrorReport keeps the agent name and leaks no raw stderr", () => {
  const RAW =
    "claude CLI error: panic secret-token-abc123 at /Users/example/.local/bin/claude line 42 (usage limit reached)";
  const out = fleetErrorReport("Sentinel", RAW);

  // Names the agent.
  assert.ok(out.includes("Sentinel"), "should name the agent");
  // Carries the friendly classification (this raw hits the usage-limit class).
  assert.ok(out.includes(plainLanguageProviderError(RAW)), "should be the plain-language line");
  // None of the raw CLI detail leaks.
  assert.ok(!out.includes("secret-token-abc123"), "raw stderr must not leak");
  assert.ok(!out.includes("CLI error"), "raw CLI detail must not leak");
  assert.ok(!out.includes(".local/bin/claude"), "CLI path must not leak");
  assert.ok(!out.includes("line 42"), "stack detail must not leak");
});

test("fleetErrorReport degrades to the generic line for an unknown/empty error", () => {
  for (const raw of [undefined, null, "", "some totally opaque internal failure blob"]) {
    const out = fleetErrorReport("Sentinel", raw);
    assert.ok(out.includes("Sentinel"));
    assert.ok(out.includes(plainLanguageProviderError(raw)));
    // The generic fallback is friendly, not a raw echo.
    if (typeof raw === "string" && raw) assert.ok(!out.includes(raw));
  }
});
