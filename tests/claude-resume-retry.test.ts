import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * End-to-end wiring of the stale-session retry (2026-07-05 incident): the
 * provider must rerun ONCE without --resume when the CLI rejects the stored
 * session id, surface the fresh run's result, and tag a failed retry's error
 * with resetProviderSession so callers drop the stale id. Exercised against a
 * fake CLI via CLAUDE_BIN — no real claude spawn.
 */

// Isolate cwd + workspace root BEFORE importing the provider: its module
// scope derives REPO_ROOT, WORK_DIR (spawn cwd), and the quota ledger path.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-retry-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const FAKE_CLI = path.join(tmp, "fake-claude.mjs");
const CALLS_LOG = path.join(tmp, "calls.log");
process.env.CLAUDE_BIN = FAKE_CLI;
// Tier-2 (S-env): the provider now passes a scrubbed, allowlisted env to the
// CLI child — arbitrary ambient vars no longer leak through. VIDI_* vars are
// carried through by design, so the fixture's coordination vars use that
// prefix to reach the fake CLI (which also proves the passthrough works).
process.env.VIDI_FAKE_CALLS_LOG = CALLS_LOG;

fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
import fs from "node:fs";
const resumed = process.argv.slice(2).includes("--resume");
fs.appendFileSync(process.env.VIDI_FAKE_CALLS_LOG, (resumed ? "resume" : "fresh") + "\\n");
const out = (o) => console.log(JSON.stringify(o));
const mode = process.env.VIDI_FAKE_CLI_MODE;
if (resumed && (mode === "stale-then-ok" || mode === "always-fail")) {
  // The incident shape: error_during_execution + "No conversation found".
  out({ type: "result", subtype: "error_during_execution", is_error: true,
        result: "No conversation found with session ID: stale-123" });
  process.exit(1);
}
if (mode === "always-fail") {
  out({ type: "result", subtype: "error_during_execution", is_error: true,
        result: "boom on the fresh run too" });
  process.exit(1);
}
if (mode === "unrelated-fail") {
  // A non-session, non-limit failure: neither the stale-session retry nor the
  // multi-account failover should fire — the error surfaces as-is. (Was
  // "usage limit reached", but that now legitimately triggers account
  // failover, so this fixture uses a genuinely unrelated failure.)
  out({ type: "result", subtype: "error_max_turns", is_error: true,
        result: "Reached the maximum number of turns" });
  process.exit(1);
}
out({ type: "system", subtype: "init", session_id: "fresh-session-42" });
out({ type: "stream_event", event: { type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" } } });
out({ type: "result", subtype: "success", is_error: false, result: "hello",
      session_id: "fresh-session-42", usage: { input_tokens: 1, output_tokens: 2 } });
process.exit(0);
`,
  { mode: 0o755 }
);

const { claudeProvider } = await import("../lib/providers/claude.ts");

async function runTurn(cliMode: string, prior: string | null) {
  process.env.VIDI_FAKE_CLI_MODE = cliMode;
  fs.writeFileSync(CALLS_LOG, "");
  const events: ProviderStreamEvent[] = [];
  for await (const ev of claudeProvider.sendMessage({
    threadId: "t-retry",
    priorProviderSessionId: prior,
    userMessage: "hi",
    model: "sonnet",
    mode: "plan",
  })) {
    events.push(ev);
  }
  const calls = fs.readFileSync(CALLS_LOG, "utf8").trim().split("\n").filter(Boolean);
  return { events, calls };
}

test("stale session → one fresh retry that succeeds; done carries the NEW session id", async () => {
  const { events, calls } = await runTurn("stale-then-ok", "stale-123");
  assert.deepEqual(calls, ["resume", "fresh"]);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.providerSessionId, "fresh-session-42");
  assert.equal(done.fullText, "hello");
});

test("stale session and the fresh retry ALSO fails → single error tagged resetProviderSession", async () => {
  const { events, calls } = await runTurn("always-fail", "stale-123");
  assert.deepEqual(calls, ["resume", "fresh"]);
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type === "error" && errors[0].resetProviderSession, true);
  assert.match(errors[0].type === "error" ? errors[0].message : "", /boom on the fresh run/);
});

test("unrelated failure while resuming → NO retry, error not tagged", async () => {
  const { events, calls } = await runTurn("unrelated-fail", "stale-123");
  assert.deepEqual(calls, ["resume"]);
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0].type === "error" ? errors[0].resetProviderSession : "set",
    undefined
  );
});

test("no stored session → single fresh run, no --resume flag", async () => {
  const { events, calls } = await runTurn("stale-then-ok", null);
  assert.deepEqual(calls, ["fresh"]);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.providerSessionId, "fresh-session-42");
});
