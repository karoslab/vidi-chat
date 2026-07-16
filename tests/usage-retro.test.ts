import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ before the module computes its cwd-based paths (matches
// quota.test.ts / diag-ledger.test.ts).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-usage-retro-")));

const { aggregate, parseUpdateLog, dayKey, buildRetro, _resetRetroCache } =
  await import("../lib/usage-retro.ts");
const { appendQuota } = await import("../lib/quota.ts");
const { bumpDiagUsage } = await import("../lib/diag-ledger.ts");

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12T12:00:00Z
const DAY = 24 * 3600_000;

function entry(over: Record<string, unknown>) {
  return {
    ts: NOW,
    provider: "claude",
    threadId: "t",
    model: "sonnet",
    mode: "chat",
    inputTokens: 10,
    outputTokens: 100,
    costUsd: 0.05,
    ...over,
  } as Parameters<typeof aggregate>[0][number];
}

test("empty ledger yields zeroed aggregate and a no-usage takeaway", () => {
  const a = aggregate([], {}, "", NOW, 30);
  assert.equal(a.totals.turns, 0);
  assert.equal(a.range, null);
  assert.deepEqual(a.byDay, []);
  assert.deepEqual(a.byModel, []);
  assert.equal(a.tts.total, 0);
  assert.equal(a.updates.total, 0);
  assert.match(a.takeaways[0], /No usage/i);
});

test("single-day single-model aggregates turns, tokens, and cost", () => {
  const a = aggregate(
    [entry({}), entry({ outputTokens: 200, costUsd: 0.1 })],
    { "tts.premium": 3, "tts.local": 1 },
    "",
    NOW,
    30
  );
  assert.equal(a.totals.turns, 2);
  assert.equal(a.totals.outputTokens, 300);
  assert.equal(a.totals.costUsd, 0.15);
  assert.equal(a.byDay.length, 1);
  assert.equal(a.byDay[0].day, "2026-07-12");
  assert.equal(a.byModel.length, 1);
  assert.equal(a.byModel[0].model, "sonnet");
  assert.equal(a.byModel[0].share, 1);
  assert.equal(a.tts.premium, 3);
  assert.equal(a.tts.total, 4);
  assert.deepEqual(a.range, { from: "2026-07-12", to: "2026-07-12" });
});

test("multi-model: share, big-model routing takeaway, and short-turn flag", () => {
  const entries = [
    // 8 big-model turns, all short (output < 60) → routing + short-turn takeaways.
    ...Array.from({ length: 8 }, () =>
      entry({ model: "opus", outputTokens: 20, costUsd: 0.4 })
    ),
    // 2 small-model turns.
    ...Array.from({ length: 2 }, () => entry({ model: "sonnet" })),
  ];
  const a = aggregate(entries, {}, "", NOW, 30);
  assert.equal(a.totals.turns, 10);
  // Sorted by turns desc → opus first.
  assert.equal(a.byModel[0].model, "opus");
  assert.equal(a.byModel[0].share, 0.8);
  const joined = a.takeaways.join(" ");
  assert.match(joined, /80 percent of turns ran on the big model \(opus\)/);
  assert.match(joined, /short turns ran on a big model/);
});

test("multi-day buckets are date-sorted and span the range", () => {
  const entries = [
    entry({ ts: NOW }),
    entry({ ts: NOW - 2 * DAY }),
    entry({ ts: NOW - 1 * DAY }),
  ];
  const a = aggregate(entries, {}, "", NOW, 30);
  assert.deepEqual(
    a.byDay.map((d) => d.day),
    ["2026-07-10", "2026-07-11", "2026-07-12"]
  );
  assert.deepEqual(a.range, { from: "2026-07-10", to: "2026-07-12" });
});

test("rolling quota windows: 5h subset of 7d", () => {
  const entries = [
    entry({ ts: NOW - 60_000 }), // in both
    entry({ ts: NOW - 6 * 3600_000 }), // in 7d only (older than 5h)
    entry({ ts: NOW - 8 * DAY }), // outside 7d
  ];
  const a = aggregate(entries, {}, "", NOW, 30);
  assert.equal(a.quota.last5h.turns, 1);
  assert.equal(a.quota.last7d.turns, 2);
});

test("parseUpdateLog counts 'update complete' lines by day", () => {
  const raw = [
    "[2026-07-10T09:00:00.000Z] update started",
    "[2026-07-10T09:03:00.000Z] update complete; restarting",
    "[2026-07-12T08:00:00.000Z] update complete; restarting",
    "[not-a-date] update complete",
    "[2026-07-12T10:00:00.000Z] downloaded 100 bytes",
  ].join("\n");
  const rows = parseUpdateLog(raw);
  assert.deepEqual(rows, [
    { day: "2026-07-10", count: 1 },
    { day: "2026-07-12", count: 1 },
  ]);
  const a = aggregate([], {}, raw, NOW, 30);
  assert.equal(a.updates.total, 2);
});

test("dayKey buckets by UTC calendar day", () => {
  assert.equal(dayKey(Date.UTC(2026, 6, 12, 23, 59)), "2026-07-12");
});

test("buildRetro reads live ledgers from data/ end to end", () => {
  _resetRetroCache();
  appendQuota({ ts: NOW, provider: "claude", threadId: "e2e", model: "opus", outputTokens: 5, costUsd: 0.2 });
  bumpDiagUsage("tts.premium", 2);
  const a = buildRetro(30, NOW);
  assert.ok(a.totals.turns >= 1);
  assert.ok(a.byModel.some((m) => m.model === "opus"));
  assert.equal(a.tts.premium, 2);
});
