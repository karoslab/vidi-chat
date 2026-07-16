import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * E2E regression for the 2026-07-05 incident: main hits a Fable limit, the
 * failover lands on the never-logged-in alt profile ("Not logged in · Please
 * run /login"), and the OLD driver persisted alt as the active account —
 * bricking every subsequent turn. The fixed driver must (a) never persist a
 * dead account, (b) skip it during rotation, and (c) target the opus
 * downgrade at an account that is actually logged in.
 *
 * Fake CLI decision table (same trick as claude-failover-e2e.test.ts —
 * CLAUDE_CONFIG_DIR is only set for alt):
 *   alt (config dir set)          → "Not logged in · Please run /login"
 *   main, --model opus            → success
 *   main, any other model         → Fable-5 limit error
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-failover-login-e2e-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

// Fable is retired: resolveRun degrades any "fable" request to opus up front,
// so this pin is now inert (kept only so nothing reads a missing cache file).
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "data", "model-availability.json"),
  JSON.stringify({ fableAvailable: true, checkedAt: Date.now(), source: "probe" })
);

const FAKE_CLI = path.join(tmp, "fake-claude.mjs");
process.env.CLAUDE_BIN = FAKE_CLI;

fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
const onAlt = !!process.env.CLAUDE_CONFIG_DIR; // provider sets it only for alt
const model = process.argv[process.argv.indexOf("--model") + 1];
const out = (o) => console.log(JSON.stringify(o));
if (onAlt) {
  // The exact alt-profile failure from the incident.
  out({ type: "result", subtype: "success", is_error: true,
        result: "Not logged in · Please run /login" });
  process.exit(1);
}
if (model === "opus") {
  out({ type: "system", subtype: "init", session_id: "opus-session-1" });
  out({ type: "stream_event", event: { type: "content_block_delta",
        delta: { type: "text_delta", text: "done on opus" } } });
  out({ type: "result", subtype: "success", is_error: false, result: "done on opus",
        session_id: "opus-session-1", usage: { input_tokens: 1, output_tokens: 2 } });
  process.exit(0);
}
out({ type: "result", subtype: "success", is_error: true,
      result: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." });
process.exit(1);
`,
  { mode: 0o755 }
);

const { claudeProvider } = await import("../lib/providers/claude.ts");
const { getActiveAccountId } = await import("../lib/accounts.ts");

async function run(model: string): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of claudeProvider.sendMessage({
    threadId: `t-login-${model}`,
    priorProviderSessionId: null,
    userMessage: "hi",
    model,
    mode: "plan",
  })) {
    events.push(ev);
  }
  return events;
}

test("main limit + alt not-logged-in (non-fable): error surfaced, dead alt NEVER persisted as active", async () => {
  const events = await run("sonnet");

  // The turn fails, and the message names both failure classes.
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.match(err.message, /usage limit/);
  assert.match(err.message, /Alt account.*not logged in/);

  // THE regression: the dead account must not become active.
  assert.equal(getActiveAccountId(), "main");
});

test("main limit + alt not-logged-in (fable pin): request runs on opus, dead alt NEVER persisted", async () => {
  // Post-fable: a "fable" request no longer routes to fable — resolveRun
  // degrades it to opus+ultracode up front, so opus runs on the FIRST attempt
  // (main, --model opus → success in the fake CLI) and the mid-turn "retrying
  // with Opus" downgrade branch in claude.ts is never reached (it is kept as
  // defensive dead code). The regression this test guards — a login-dead alt
  // must never become the active account — still holds.
  const events = await run("fable");

  // Recovered — no error; the opus reply streamed on the first attempt.
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  const text = events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text)
    .join("");
  assert.match(text, /done on opus/);

  // done reports main, and main stays active (dead alt never persisted).
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.accountId, "main");
  assert.equal(getActiveAccountId(), "main");
});
