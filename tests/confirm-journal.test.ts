import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Batch A item 7 — confirm-run observability. confirmPending used to swallow the
 * executor error with ZERO logging and journal only the FILING, so tonight's
 * four calendar failures showed only the generic spoken line and the real errors
 * had to be reconstructed by hand. Now every run journals its outcome:
 *   - success → `confirm-executed:<kind> <description>`
 *   - throw   → `confirm-failed:<kind> <first ~200 chars of the real error>`
 * The journal lives under cwd/data, so we isolate cwd before importing.
 */

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-journal-test-"));
process.chdir(CWD);
fs.mkdirSync(path.join(CWD, "data"), { recursive: true });

const T0 = 1_000_000_000_000;
const JOURNAL_FILE = path.join(CWD, "data", "journal.jsonl");

const {
  fileConfirm,
  confirmPending,
  cancelPending,
  registerExecutor,
} = await import("../lib/confirm.ts");

function journalLines(): { tool: string; summary: string; threadId: string }[] {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  return fs
    .readFileSync(JOURNAL_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a successful confirm journals confirm-executed:<kind> with the description", async () => {
  cancelPending(T0);
  registerExecutor("journal-ok-kind", async () => "did the thing");
  const { nonce } = fileConfirm(
    { kind: "journal-ok-kind", payload: {}, description: "send the report" },
    { now: T0 }
  );
  const res = await confirmPending(T0, { nonce });
  assert.equal(res.ran, true);
  assert.equal(res.text, "did the thing");

  const executed = journalLines().find((l) => l.tool === "confirm-executed:journal-ok-kind");
  assert.ok(executed, "a success must journal confirm-executed:<kind>");
  assert.equal(executed!.threadId, "confirm");
  assert.match(executed!.summary, /send the report/);
});

test("a throwing confirm journals confirm-failed:<kind> with the real error, spoken text stays generic", async () => {
  cancelPending(T0);
  registerExecutor("journal-fail-kind", async () => {
    throw new Error("gws: unrecognized subcommand 'create'");
  });
  const { nonce } = fileConfirm(
    { kind: "journal-fail-kind", payload: {}, description: "make an event" },
    { now: T0 }
  );
  const res = await confirmPending(T0, { nonce });
  // Spoken text is still the calm generic line — the detail goes to the journal.
  assert.equal(res.text, "I tried, but that didn't go through.");

  const failed = journalLines().find((l) => l.tool === "confirm-failed:journal-fail-kind");
  assert.ok(failed, "a throw must journal confirm-failed:<kind>");
  assert.match(failed!.summary, /unrecognized subcommand/);
});
