import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * The stop button (lib/turn-abort.ts + app/api/threads/[id]/stop/route.ts)
 * aborts SendMessageArgs.signal. Verifies claude.ts's onAbort: the partial
 * text streamed so far persists as a normal `done` flagged `stopped: true` —
 * never a bare "run aborted" error, and never a contradicting second event
 * (the exitCode-is-still-null-this-tick trap). Exercised against a fake CLI
 * via CLAUDE_BIN — no real claude spawn.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-stop-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const FAKE_CLI = path.join(tmp, "fake-claude-stop.mjs");
process.env.CLAUDE_BIN = FAKE_CLI;

fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: "stop-session-1" });
out({ type: "stream_event", event: { type: "content_block_delta",
      delta: { type: "text_delta", text: "partial answer before the stop" } } });
// Stay alive until SIGKILLed by the abort — simulates a long-running turn.
setInterval(() => {}, 1000);
`,
  { mode: 0o755 }
);

const { claudeProvider } = await import("../lib/providers/claude.ts");

test("aborting mid-stream persists the partial text as a done, flagged stopped — no error", async () => {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const ev of claudeProvider.sendMessage({
    threadId: "t-stop",
    userMessage: "hi",
    model: "sonnet",
    mode: "plan",
    signal: controller.signal,
  })) {
    events.push(ev);
    if (ev.type === "delta") controller.abort();
  }

  assert.equal(events.filter((e) => e.type === "error").length, 0);
  const dones = events.filter((e) => e.type === "done");
  assert.equal(dones.length, 1, "exactly one done — no trailing contradicting error/done");
  const done = dones[0];
  assert.ok(done.type === "done");
  assert.equal(done.stopped, true);
  assert.equal(done.fullText, "partial answer before the stop");
  assert.equal(done.providerSessionId, "stop-session-1");
});
