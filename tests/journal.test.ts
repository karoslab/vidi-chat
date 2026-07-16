import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// journal.ts computes JOURNAL_FILE = path.join(process.cwd(), "data/journal.jsonl")
// once at module-load time — chdir only affects that one captured path.
// So we chdir into a temp dir BEFORE import, and reset the single journal file
// between tests rather than switching cwd.
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journal-test-"));
process.chdir(testCwd);

const { appendJournal, readJournal } = await import("../lib/journal.ts");
import type { JournalEntry } from "../lib/journal.ts";

const JOURNAL_FILE = path.join(testCwd, "data", "journal.jsonl");

function resetJournal() {
  try {
    fs.rmSync(JOURNAL_FILE);
  } catch {
    // file may not exist yet — that's fine
  }
}

// Serialize all tests: they share the same JOURNAL_FILE path (module-global),
// so concurrent runs would interfere with each other.
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  });
}

serial("readJournal returns empty array when journal file is absent (fail-open)", () => {
  resetJournal();
  const entries = readJournal();
  assert.deepEqual(entries, []);
});

serial("appendJournal writes entries that readJournal reads back newest-first", () => {
  resetJournal();

  const e1: JournalEntry = { ts: 1000, threadId: "t1", tool: "Read", summary: "file.ts" };
  const e2: JournalEntry = { ts: 2000, threadId: "t1", tool: "Edit", summary: "file.ts:10" };
  const e3: JournalEntry = { ts: 3000, threadId: "t2", tool: "Bash", summary: "npm test" };

  appendJournal(e1);
  appendJournal(e2);
  appendJournal(e3);

  const entries = readJournal();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], e3);
  assert.deepEqual(entries[1], e2);
  assert.deepEqual(entries[2], e1);
});

serial("readJournal respects the limit parameter", () => {
  resetJournal();

  for (let i = 0; i < 5; i++) {
    appendJournal({ ts: i, threadId: "t", tool: "Read", summary: `step ${i}` });
  }

  const top2 = readJournal(2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].ts, 4);
  assert.equal(top2[1].ts, 3);
});

serial("readJournal silently skips corrupt JSONL lines", () => {
  resetJournal();

  const dataDir = path.dirname(JOURNAL_FILE);
  fs.mkdirSync(dataDir, { recursive: true });

  const good: JournalEntry = { ts: 9000, threadId: "t", tool: "Bash", summary: "ls" };
  fs.writeFileSync(
    JOURNAL_FILE,
    ["NOT VALID JSON <<<", JSON.stringify(good), "", "{incomplete"].join("\n") + "\n"
  );

  const entries = readJournal();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], good);
});
