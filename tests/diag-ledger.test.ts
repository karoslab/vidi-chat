import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Diagnostics ledger (DIAGNOSTICS + FEEDBACK loop): capture + scrub (assert
 * $HOME paths and hex runs removed), rotation bound, usage counters, session
 * counts, provider classification. Isolated in a temp cwd so the ledger writes
 * under <tmp>/data, never the live data dir.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-diag-")));

const {
  DIAG_MAX_ENTRIES,
  recordDiag,
  recordProviderDiag,
  classifyProviderCategory,
  readRecentDiag,
  diagCategoryCounts,
  scrubDiagMessage,
  sessionSameCategoryCount,
  _resetSessionCounts,
  bumpDiagUsage,
  readDiagUsage,
} = await import("../lib/diag-ledger.ts");

test("scrubDiagMessage strips $HOME/absolute paths, hex runs, and base64 tokens", () => {
  const home = os.homedir();
  const raw = `failed at ${home}/Projects/app/secret.ts hash deadbeefCAFEbabe1234 tok QUJDREVGR0hJSktMTU5PUFFSU1RVVldY`;
  const scrubbed = scrubDiagMessage(raw);
  assert.ok(!scrubbed.includes(home), "home dir must be removed");
  assert.ok(!scrubbed.includes("/Users/") && !scrubbed.includes("/home/"), "absolute user paths must be removed");
  assert.ok(!/deadbeefCAFEbabe1234/.test(scrubbed), "long hex run must be removed");
  assert.ok(!/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY/.test(scrubbed), "base64 token must be removed");
  assert.ok(scrubbed.includes("<path>"), "path placeholder present");
  assert.ok(scrubbed.includes("failed at"), "benign words survive");
});

test("scrubDiagMessage collapses to one line and caps length", () => {
  const scrubbed = scrubDiagMessage("line one\nline two\t\tspaced");
  assert.ok(!scrubbed.includes("\n"), "no newlines");
  const long = scrubDiagMessage("x".repeat(2000));
  assert.ok(long.length <= 400, `capped, got ${long.length}`);
});

test("recordDiag writes a scrubbed entry the ledger reads back", () => {
  _resetSessionCounts();
  const home = os.homedir();
  recordDiag("tts-fail", `boom in ${home}/data/x with id abcdef0123456789abcd`, 1_000);
  const recent = readRecentDiag(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].category, "tts-fail");
  assert.ok(!recent[0].message.includes(home), "no home path on disk");
  assert.ok(!/abcdef0123456789abcd/.test(recent[0].message), "no hex id on disk");
  assert.ok(recent[0].build.length > 0, "build id stamped");
});

test("ledger is bounded to DIAG_MAX_ENTRIES (oldest dropped, newest kept)", () => {
  for (let i = 0; i < DIAG_MAX_ENTRIES + 25; i++) {
    recordDiag("route-error", `err ${i}`, 2_000 + i);
  }
  const counts = diagCategoryCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(total <= DIAG_MAX_ENTRIES, `total ${total} <= ${DIAG_MAX_ENTRIES}`);
  // Newest is present; the very first "err 0" has been rotated out.
  const messages = readRecentDiag(DIAG_MAX_ENTRIES).map((e) => e.message);
  assert.ok(messages.includes(`err ${DIAG_MAX_ENTRIES + 24}`), "newest kept");
  assert.ok(!messages.includes("err 0"), "oldest dropped");
});

test("recordProviderDiag classifies spawn-crash vs provider-fail", () => {
  assert.equal(classifyProviderCategory("failed to spawn claude CLI: ENOENT"), "spawn-crash");
  assert.equal(classifyProviderCategory("claude CLI error: usage limit"), "provider-fail");
  _resetSessionCounts();
  recordProviderDiag("failed to spawn claude CLI");
  recordProviderDiag("some other provider error");
  assert.equal(sessionSameCategoryCount("spawn-crash"), 1);
  assert.equal(sessionSameCategoryCount("provider-fail"), 1);
});

test("session counters increment per category and reset", () => {
  _resetSessionCounts();
  assert.equal(sessionSameCategoryCount("provider-fail"), 0);
  recordDiag("provider-fail", "a");
  recordDiag("provider-fail", "b");
  assert.equal(sessionSameCategoryCount("provider-fail"), 2);
  _resetSessionCounts();
  assert.equal(sessionSameCategoryCount("provider-fail"), 0);
});

test("usage counters accumulate and read back as numbers only", () => {
  bumpDiagUsage("tts.premium");
  bumpDiagUsage("tts.premium");
  bumpDiagUsage("desk.approvals", 3);
  const usage = readDiagUsage();
  assert.equal(usage["tts.premium"], 2);
  assert.equal(usage["desk.approvals"], 3);
  for (const v of Object.values(usage)) assert.equal(typeof v, "number");
});
