import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pure decide() needs no data/ dir, but the ledger round-trip does, so
// isolate cwd before importing (same pattern as store.test.ts).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-policy-test-")));
const { decide, recordSpoken, recordChime, todaysCounts } = await import(
  "../lib/policy.ts"
);

import type {
  VidiEvent,
  PolicyInputs,
  PresenceState,
  EventPriority,
} from "../lib/events-types.ts";

// A daytime, wide-awake, budget-clear baseline. Individual tests override one
// dimension so each asserts exactly the rule row it targets. 14:00 local dodges
// quiet hours; ts == now and a generous TTL dodge the drop rule.
const NOW = new Date(2026, 6, 3, 14, 0, 0); // 2026-07-03 14:00 local

function evt(priority: EventPriority, over: Partial<VidiEvent> = {}): VidiEvent {
  return {
    id: "evt-test",
    ts: NOW.getTime(),
    source: "test",
    kind: "test.kind",
    priority,
    title: "t",
    spoken: "s",
    ttlMinutes: 60,
    ...over,
  };
}

const PRESENT: PresenceState = {
  presence: "active",
  idleSeconds: 5,
  screenLocked: false,
  fullscreen: false,
  micActive: false,
};

function inputs(over: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    now: NOW,
    presence: { ...PRESENT },
    inMeeting: false,
    dndOrQuiet: false,
    spokenTodayCount: 0,
    lastSpokenAtMs: null,
    chimeTodayCount: 0,
    ...over,
  };
}

// (1) TTL --------------------------------------------------------------------

test("rule 1: expired TTL drops, even for critical", () => {
  // ts is 61 min ago with a 60 min TTL — stale. Critical would otherwise speak.
  const stale = evt("critical", { ts: NOW.getTime() - 61 * 60000, ttlMinutes: 60 });
  const d = decide(stale, inputs());
  assert.equal(d.deliver, "drop");
});

test("rule 1: event exactly at TTL boundary is NOT dropped", () => {
  const edge = evt("normal", { ts: NOW.getTime() - 60 * 60000, ttlMinutes: 60 });
  assert.notEqual(decide(edge, inputs()).deliver, "drop");
});

// (2) Critical ---------------------------------------------------------------

test("rule 2: critical speaks", () => {
  assert.equal(decide(evt("critical"), inputs()).deliver, "speak");
});

test("rule 2: critical speaks even while presenting (before empty-room/present rules)", () => {
  const d = decide(evt("critical"), inputs({ inMeeting: true }));
  assert.equal(d.deliver, "speak");
});

// (3) Quiet hours ------------------------------------------------------------

test("rule 3: quiet hours (23:00) — high pushes", () => {
  const night = new Date(2026, 6, 3, 23, 0, 0);
  const d = decide(evt("high", { ts: night.getTime() }), inputs({ now: night }));
  assert.equal(d.deliver, "push");
});

test("rule 3: quiet hours (02:00) — normal queues", () => {
  const night = new Date(2026, 6, 3, 2, 0, 0);
  // ts must be recent relative to this `now` so TTL doesn't fire first.
  const e = evt("normal", { ts: night.getTime() });
  assert.equal(decide(e, inputs({ now: night })).deliver, "queue");
});

test("rule 3: 08:00 is NOT quiet (boundary), 07:59 is", () => {
  const eight = new Date(2026, 6, 3, 8, 0, 0);
  const before = new Date(2026, 6, 3, 7, 59, 0);
  const e8 = evt("normal", { ts: eight.getTime() });
  const e759 = evt("normal", { ts: before.getTime() });
  assert.notEqual(decide(e8, inputs({ now: eight })).deliver, "queue"); // chimes (default)
  assert.equal(decide(e759, inputs({ now: before })).deliver, "queue"); // quiet
});

// (4) Empty room -------------------------------------------------------------

test("rule 4: screen locked — high pushes, normal queues", () => {
  const locked: PresenceState = { ...PRESENT, screenLocked: true };
  assert.equal(decide(evt("high"), inputs({ presence: locked })).deliver, "push");
  assert.equal(decide(evt("normal"), inputs({ presence: locked })).deliver, "queue");
});

test("rule 4: idle > 900s is an empty room", () => {
  const idle: PresenceState = { ...PRESENT, idleSeconds: 901 };
  assert.equal(decide(evt("high"), inputs({ presence: idle })).deliver, "push");
});

test("rule 4: idle at exactly 900s is NOT empty (boundary)", () => {
  const idle: PresenceState = { ...PRESENT, idleSeconds: 900 };
  // Falls through to default: high speaks.
  assert.equal(decide(evt("high"), inputs({ presence: idle })).deliver, "speak");
});

// (5) Presenting -------------------------------------------------------------

test("rule 5: in meeting — high pushes, low queues", () => {
  assert.equal(decide(evt("high"), inputs({ inMeeting: true })).deliver, "push");
  assert.equal(decide(evt("low"), inputs({ inMeeting: true })).deliver, "queue");
});

test("rule 5: fullscreen presenting queues a normal event", () => {
  const fs2: PresenceState = { ...PRESENT, fullscreen: true };
  assert.equal(decide(evt("normal"), inputs({ presence: fs2 })).deliver, "queue");
});

test("rule 5: hot mic pushes a high event", () => {
  const mic: PresenceState = { ...PRESENT, micActive: true };
  assert.equal(decide(evt("high"), inputs({ presence: mic })).deliver, "push");
});

// (6) DND --------------------------------------------------------------------

test("rule 6: DND/quiet — high pushes, normal queues", () => {
  assert.equal(decide(evt("high"), inputs({ dndOrQuiet: true })).deliver, "push");
  assert.equal(decide(evt("normal"), inputs({ dndOrQuiet: true })).deliver, "queue");
});

// (7) Speech budget ----------------------------------------------------------

test("rule 7: daily speech budget spent — a high downgrades to chime", () => {
  const d = decide(evt("high"), inputs({ spokenTodayCount: 6 }));
  assert.equal(d.deliver, "chime");
});

test("rule 7: budget spent AND chime budget spent — queues", () => {
  const d = decide(
    evt("high"),
    inputs({ spokenTodayCount: 6, chimeTodayCount: 10 })
  );
  assert.equal(d.deliver, "queue");
});

test("rule 7: spacing window — spoke 5 min ago downgrades to chime", () => {
  const d = decide(
    evt("high"),
    inputs({ lastSpokenAtMs: NOW.getTime() - 5 * 60000 })
  );
  assert.equal(d.deliver, "chime");
});

test("rule 7: spacing satisfied — spoke 21 min ago still speaks", () => {
  const d = decide(
    evt("high"),
    inputs({ lastSpokenAtMs: NOW.getTime() - 21 * 60000 })
  );
  assert.equal(d.deliver, "speak");
});

// (8) Defaults ---------------------------------------------------------------

test("rule 8: default high speaks, normal chimes, low queues", () => {
  assert.equal(decide(evt("high"), inputs()).deliver, "speak");
  assert.equal(decide(evt("normal"), inputs()).deliver, "chime");
  assert.equal(decide(evt("low"), inputs()).deliver, "queue");
});

// Null presence --------------------------------------------------------------

test("null presence: skips empty-room and presenting rules; high still speaks", () => {
  // inMeeting false, but even a mic-active-like world can't be read when
  // presence is null. Budget clear + daytime → default high speaks.
  const d = decide(evt("high"), inputs({ presence: null }));
  assert.equal(d.deliver, "speak");
});

test("null presence: quiet hours still apply", () => {
  const night = new Date(2026, 6, 3, 23, 30, 0);
  const e = evt("normal", { ts: night.getTime() });
  const d = decide(e, inputs({ presence: null, now: night }));
  assert.equal(d.deliver, "queue");
});

test("null presence: DND still applies", () => {
  const d = decide(evt("normal"), inputs({ presence: null, dndOrQuiet: true }));
  assert.equal(d.deliver, "queue");
});

// Ledger round-trip ----------------------------------------------------------

test("ledger: recordSpoken/recordChime then todaysCounts reflects today's entries", () => {
  // Fresh temp cwd so the ledger starts empty for this test.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-policy-ledger-")));
  const now = new Date();

  assert.deepEqual(todaysCounts(now), {
    spokenTodayCount: 0,
    chimeTodayCount: 0,
    lastSpokenAtMs: null,
  });

  const t1 = now.getTime() - 3000;
  const t2 = now.getTime() - 1000;
  recordSpoken(t1);
  recordSpoken(t2);
  recordChime(now.getTime());

  const counts = todaysCounts(now);
  assert.equal(counts.spokenTodayCount, 2);
  assert.equal(counts.chimeTodayCount, 1);
  assert.equal(counts.lastSpokenAtMs, t2); // most recent speak
});

test("ledger: entries from a different local day are not counted", () => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-policy-ledger2-")));
  const now = new Date(2026, 6, 3, 14, 0, 0);
  const yesterday = new Date(2026, 6, 2, 14, 0, 0).getTime();

  recordSpoken(yesterday);
  recordSpoken(now.getTime());

  const counts = todaysCounts(now);
  assert.equal(counts.spokenTodayCount, 1);
  assert.equal(counts.lastSpokenAtMs, now.getTime());
});

test("ledger: missing file fails open to zeros", () => {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-policy-empty-")));
  assert.deepEqual(todaysCounts(new Date()), {
    spokenTodayCount: 0,
    chimeTodayCount: 0,
    lastSpokenAtMs: null,
  });
});
