import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// These suites model the OWNER install (owner-default identity in prompts
// and brain paths). The customer identity contract is pinned in user-config.test.ts.
process.env.VIDI_OWNER = "1";

// The export heading interpolates the resolved displayName; on the owner install
// that is the built-in default, sourced here so the expectation never restates
// the owner's literal name.
const { DEFAULT_USER_CONFIG } = await import("../lib/user-config.ts");


// store.ts reads/writes under process.cwd()/data — isolate to a temp dir.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-export-")));
const { threadToMarkdown, exportFilename, saveThread, getThread } = await import(
  "../lib/store.ts"
);

const thread = {
  id: "abc-123",
  title: "A Good Session!",
  provider: "claude",
  model: "opus",
  providerSessionId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  messages: [
    { role: "user" as const, text: "read lib/store.ts", ts: 1_700_000_000_000 },
    {
      role: "assistant" as const,
      text: "Done.\n\n```\nRead lib/store.ts\n```",
      ts: 1_700_000_050_000,
    },
  ],
};

test("threadToMarkdown emits a faithful, unstripped transcript", () => {
  const md = threadToMarkdown(thread);
  assert.match(md, /^# A Good Session!/);
  assert.match(md, /- Thread: `abc-123`/);
  assert.match(md, /- Provider: claude \(opus\)/);
  assert.match(md, new RegExp("## 🧑 " + DEFAULT_USER_CONFIG.displayName));
  assert.match(md, /## 🤖 Vidi/);
  // verbatim: fenced tool block preserved, nothing sanitized away
  assert.ok(md.includes("read lib/store.ts"));
  assert.ok(md.includes("```\nRead lib/store.ts\n```"));
});

test("exportFilename slugifies title, falls back to id, always .md", () => {
  assert.equal(exportFilename(thread), "a-good-session.md");
  assert.equal(exportFilename({ ...thread, title: "" }), "abc-123.md");
  assert.equal(exportFilename({ ...thread, title: "!!!" }), "abc-123.md");
});

test("round-trips through disk store (getThread → markdown)", () => {
  saveThread(thread as any);
  const loaded = getThread("abc-123");
  assert.ok(loaded);
  assert.match(threadToMarkdown(loaded!), /## 🤖 Vidi/);
});
