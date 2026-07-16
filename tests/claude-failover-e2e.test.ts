import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * End-to-end multi-account failover against a fake CLI (CLAUDE_BIN) — no real
 * claude spawn, and no second logged-in account needed. The fake CLI decides
 * its behavior from CLAUDE_CONFIG_DIR: the "main" account leaves it UNSET (the
 * provider only sets it for accounts with a non-null configDir), the "alt"
 * account sets it to ~/.claude-profiles/alt. So "config dir unset" == main.
 *
 * We drive the provider's real sendMessage loop and assert the rotation:
 * main hits a Fable-5 limit → provider fails over to alt → alt succeeds, the
 * reply is prefixed with the switch notice, and the done event reports alt.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-failover-e2e-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const FAKE_CLI = path.join(tmp, "fake-claude.mjs");
process.env.CLAUDE_BIN = FAKE_CLI;

fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
const onAlt = !!process.env.CLAUDE_CONFIG_DIR; // provider sets it only for alt
const out = (o) => console.log(JSON.stringify(o));
if (!onAlt) {
  // main account: the exact Fable-5 limit message from the incident.
  out({ type: "result", subtype: "success", is_error: true,
        result: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." });
  process.exit(1);
}
// alt account: a clean success.
out({ type: "system", subtype: "init", session_id: "alt-session-7" });
out({ type: "stream_event", event: { type: "content_block_delta",
      delta: { type: "text_delta", text: "done on alt" } } });
out({ type: "result", subtype: "success", is_error: false, result: "done on alt",
      session_id: "alt-session-7", usage: { input_tokens: 1, output_tokens: 2 } });
process.exit(0);
`,
  { mode: 0o755 }
);

const { claudeProvider } = await import("../lib/providers/claude.ts");
const { getActiveAccountId } = await import("../lib/accounts.ts");
const { readJournal } = await import("../lib/journal.ts");

test("limit on main → fails over to alt, prefixes the switch notice, done reports alt", async () => {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of claudeProvider.sendMessage({
    threadId: "t-fo",
    priorProviderSessionId: null,
    userMessage: "hi",
    model: "sonnet",
    mode: "plan",
  })) {
    events.push(ev);
  }

  // No error surfaced — the turn recovered on alt.
  assert.equal(events.filter((e) => e.type === "error").length, 0);

  // The reply text carries the visible one-line switch notice.
  const text = events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "delta" }> => e.type === "delta")
    .map((e) => e.text)
    .join("");
  assert.match(text, /switched to Alt account/);
  assert.match(text, /done on alt/);

  // done reports the account that actually worked, so #3 stamps the right owner.
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.accountId, "alt");
  assert.equal(done.providerSessionId, "alt-session-7");
  // Durability: the switch notice is folded into the PERSISTED fullText, not
  // just streamed — so it survives in the thread transcript after a reload.
  assert.match(done.fullText, /switched to Alt account/);

  // The active account was persisted to the winner (next turn won't re-fail).
  assert.equal(getActiveAccountId(), "alt");

  // The switch is journaled so "what did you do" recall sees it.
  assert.ok(readJournal(20).some((j) => j.tool === "account-switch"));
});
