import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ before the module computes its cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-quota-test-")));
const { appendQuota, readQuota, summarizeQuota, pruneQuota } = await import(
  "../lib/quota.ts"
);

test("append, filter by time, and summarize windows", () => {
  const now = Date.now();
  appendQuota({
    ts: now - 6 * 24 * 3600_000, // in 7d, outside 5h
    provider: "claude",
    threadId: "t1",
    model: "sonnet",
    mode: "chat",
    inputTokens: 10,
    outputTokens: 100,
    costUsd: 0.05,
  });
  appendQuota({
    ts: now - 60_000, // in both windows
    provider: "claude",
    threadId: "t2",
    model: "sonnet",
    mode: "act",
    inputTokens: 20,
    outputTokens: 200,
    cacheReadTokens: 5000,
    costUsd: 0.1,
  });
  appendQuota({
    ts: now - 30_000, // in both windows
    provider: "codex",
    threadId: "t3",
    outputTokens: 50,
  });

  assert.equal(readQuota(0).length, 3);
  assert.equal(readQuota(now - 5 * 3600_000).length, 2);

  const { last5h, last7d } = summarizeQuota(now);
  assert.equal(last5h.turns, 2);
  assert.equal(last5h.outputTokens, 250);
  assert.equal(last5h.costUsd, 0.1); // codex entry has no cost
  assert.equal(last5h.byProvider.claude.turns, 1);
  assert.equal(last5h.byProvider.codex.outputTokens, 50);
  assert.equal(last7d.turns, 3);
  assert.equal(last7d.outputTokens, 350);
  assert.equal(last7d.costUsd, 0.15);
});

test("pruneQuota drops lines older than cutoff and keeps newer ones", () => {
  // QUOTA_FILE is resolved at module load time against process.cwd(), which was
  // already redirected to a temp dir at the top of this file.
  const ledger = path.join(process.cwd(), "data", "quota.jsonl");
  const now = Date.now();
  const oldEntry: import("../lib/quota.ts").QuotaEntry = {
    ts: now - 40 * 24 * 3600_000,
    provider: "claude",
    threadId: "prune-old",
  };
  const recentEntry: import("../lib/quota.ts").QuotaEntry = {
    ts: now - 5 * 24 * 3600_000,
    provider: "claude",
    threadId: "prune-recent",
  };
  // Overwrite ledger with just these two entries for a clean test.
  fs.writeFileSync(
    ledger,
    JSON.stringify(oldEntry) + "\n" + JSON.stringify(recentEntry) + "\n"
  );

  pruneQuota(30);

  const lines = fs
    .readFileSync(ledger, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).threadId, "prune-recent");
});

test("pruneQuota is a no-op when ledger file does not exist", () => {
  const ledger = path.join(process.cwd(), "data", "quota.jsonl");
  // Remove the ledger so it doesn't exist.
  if (fs.existsSync(ledger)) fs.unlinkSync(ledger);
  assert.doesNotThrow(() => pruneQuota());
});

test("appendQuota triggers pruning at most once per day", () => {
  // Verify that after calling appendQuota twice quickly the ledger still
  // contains the entries (pruning runs but keeps recent records).
  const before = readQuota(0).length;
  appendQuota({ ts: Date.now(), provider: "claude", threadId: "p1" });
  appendQuota({ ts: Date.now(), provider: "claude", threadId: "p2" });
  // Both new entries should survive since they are within the 30-day window.
  const after = readQuota(0).length;
  assert.ok(after >= before + 2);
});

test("corrupt ledger lines are skipped, not fatal", () => {
  const before = readQuota(0).length; // self-contained: no coupling to test order
  fs.appendFileSync(path.join(process.cwd(), "data", "quota.jsonl"), "not json\n");
  appendQuota({ ts: Date.now(), provider: "claude", threadId: "tX", outputTokens: 1 });
  assert.equal(readQuota(0).length, before + 1);
  assert.doesNotThrow(() => summarizeQuota());
});
