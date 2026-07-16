import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tier-2 (S-redact) wiring: appendJournal() must run its summary through the
 * redactor before persisting, so a secret in a tool-input summary never lands
 * in the browser-readable data/journal.jsonl.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journal-redact-"));
process.chdir(tmp);

const { appendJournal, readJournal } = await import("../lib/journal.ts");

test("appendJournal redacts a secret in the summary", () => {
  appendJournal({
    ts: Date.now(),
    threadId: "t1",
    tool: "Bash",
    summary: `curl -H "Authorization: Bearer sk-ant-abcdefghij1234567890"`,
  });
  const raw = fs.readFileSync(path.join(tmp, "data", "journal.jsonl"), "utf8");
  assert.ok(!raw.includes("sk-ant-abcdefghij1234567890"), "secret must not be on disk");
  assert.ok(raw.includes("[REDACTED]"));
  // The entry is still a valid, readable journal line.
  const entries = readJournal(1);
  assert.equal(entries[0].tool, "Bash");
  assert.match(entries[0].summary, /\[REDACTED\]/);
});
