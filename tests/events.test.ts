import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the cwd-based data/ dir (dedupe set, queued.jsonl, log.jsonl, and the
// policy ledger) before the broker/policy modules resolve any cwd paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-events-test-")));

const {
  drainPending,
  processFile,
  maybeEveningWrap,
  maybeEscalateAnticipation,
  maybeGreetingCatchup,
} = await import("../lib/events.ts");
const { ANTICIPATION_ESCALATION_GRACE_MS } = await import("../lib/anticipation.ts");
import type { BrokerDeps } from "../lib/events.ts";
import type { VidiEvent } from "../lib/events-types.ts";
import type { MacPresence } from "../lib/context.ts";

/* -------------------------------------------------------------------------- */
/* Test harness: temp spool dirs + fully-faked side-effecting deps            */
/* -------------------------------------------------------------------------- */

interface Calls {
  hands: Record<string, unknown>[];
  pushes: { title: string; body: string; priority: string }[];
  spoken: number[];
  chimes: number[];
}

/**
 * Build a fresh temp pending/done pair and an injectable BrokerDeps with all
 * spawning collaborators replaced by recorders. `handsReply` lets a test steer
 * the fake Hands server (busy, ok:false, or a presence snapshot). Nothing real
 * is spawned: no :4184 Hands server, no notify.py.
 */
function harness(opts?: {
  handsReply?: (action: Record<string, unknown>) => any;
  quiet?: boolean;
  presence?: MacPresence | null;
  todaysCounts?: () => { spokenTodayCount: number; chimeTodayCount: number; lastSpokenAtMs: number | null };
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-spool-"));
  const pending = path.join(root, "pending");
  const done = path.join(root, "done");
  fs.mkdirSync(pending, { recursive: true });
  fs.mkdirSync(done, { recursive: true });

  const calls: Calls = { hands: [], pushes: [], spoken: [], chimes: [] };

  const deps: BrokerDeps = {
    async handsAct(action) {
      calls.hands.push(action);
      // Default: presence verb is unknown today → failure; other actions ok.
      if (opts?.handsReply) return opts.handsReply(action);
      if (action.action === "presence") return { ok: false };
      return { ok: true };
    },
    async pushToPhone(title, body, priority) {
      calls.pushes.push({ title, body, priority });
      return true;
    },
    isQuiet: () => opts?.quiet === true,
    recordSpoken: (ts) => calls.spoken.push(ts),
    recordChime: (ts) => calls.chimes.push(ts),
    // Empty ledger by default; a test that needs budgets exercised overrides.
    todaysCounts: opts?.todaysCounts ?? (() => ({ spokenTodayCount: 0, chimeTodayCount: 0, lastSpokenAtMs: null })),
    // Presence unknown by default (null → conservative). Tests steer it.
    getMacPresence: async () => opts?.presence ?? null,
    dirs: { pending, done },
  };

  return { root, pending, done, calls, deps };
}

/** Write a synthetic event straight into pending/ as the producer would. */
function spool(pending: string, e: Partial<VidiEvent> & { spoken: string; title: string }): VidiEvent {
  const now = Date.now();
  const event: VidiEvent = {
    id: e.id ?? `evt-${now}-${Math.random().toString(16).slice(2, 10)}`,
    ts: e.ts ?? now,
    source: e.source ?? "test",
    kind: e.kind ?? "test.kind",
    priority: e.priority ?? "normal",
    title: e.title,
    spoken: e.spoken,
    detail: e.detail,
    ttlMinutes: e.ttlMinutes ?? 60,
    dedupeKey: e.dedupeKey,
  };
  fs.writeFileSync(path.join(pending, `${event.id}.json`), JSON.stringify(event));
  return event;
}

/**
 * Run `fn` with the global Date frozen at `fixedMs`, then restore it. The
 * anticipation moments read `new Date()`/`Date.now()` internally (the broker
 * bypass can't take an injected clock), so pinning the wall clock is the only
 * way to exercise "at 06:30" or "after 18:00" deterministically.
 */
async function withFixedNow<T>(fixedMs: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixedMs);
      else super(...(args as []));
    }
    static now() {
      return fixedMs;
    }
  }
  (globalThis as any).Date = FakeDate;
  try {
    return await fn();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

/** The per-date ledgers + queue live in the shared test cwd, so anticipation
 *  tests wipe them first to stay independent of each other and of the spool
 *  tests above (which append to queued.jsonl). */
function clearAnticipationLedgers(): void {
  const dir = path.join(process.cwd(), "data", "events");
  for (const f of [
    "greeting-ledger.json",
    "evening-wrap-ledger.json",
    "queued.jsonl",
    "spoken-ledger.jsonl",
  ]) {
    try {
      fs.rmSync(path.join(dir, f));
    } catch {
      /* absent is fine */
    }
  }
}

function readQueued(): VidiEvent[] {
  const p = path.join(process.cwd(), "data", "events", "queued.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test("normal event, no presence, empty ledger → chimes (per policy default)", async () => {
  // Pin the clock to a waking hour (14:00). policy rule (3) quiet-hours
  // (hour >= 22 || hour < 8) is NOT presence-gated, so at night this event would
  // legitimately QUEUE — which has nothing to do with the null-presence path we
  // mean to exercise here. Every anticipation test below pins `now` for the same
  // reason; this default-path test must too, or it flips chime→queue overnight.
  const at1400 = new Date(2026, 0, 15, 14, 0, 0).getTime();
  const h = harness();
  let e!: VidiEvent;

  await withFixedNow(at1400, async () => {
    e = spool(h.pending, {
      priority: "normal",
      title: "Release gate held myapp",
      spoken: "Release gate held myapp.",
      kind: "dg.verdict.flip",
    });

    await drainPending(h.deps);
  });

  // Policy rules (4)/(5) empty-room + presenting are SKIPPED when presence is
  // null (fail-open: null must not fabricate an empty room). With a clear/unknown
  // room, an empty budget ledger, and a waking hour, flow reaches rule (8):
  // default normal priority → chime.
  assert.equal(h.calls.chimes.length, 1, "normal priority chimes on a clear/unknown room");
  assert.equal(h.calls.hands.some((a) => a.action === "chime"), true);
  // Terminal: moved out of pending/, into done/.
  assert.deepEqual(fs.readdirSync(h.pending), []);
  assert.equal(fs.readdirSync(h.done).length, 1, `${e.id} moved to done/`);
});

test("low-priority event with empty ledger → queued.jsonl", async () => {
  const h = harness();
  const e = spool(h.pending, {
    priority: "low",
    title: "background note",
    spoken: "A quiet background note.",
  });

  await drainPending(h.deps);

  const queued = readQueued();
  assert.equal(queued.some((q) => q.id === e.id), true, "low priority appended to queued.jsonl");
  assert.equal(h.calls.hands.filter((a) => a.action !== "presence").length, 0, "no speak/chime for a queued event");
  assert.deepEqual(fs.readdirSync(h.pending), []);
});

test("ttl-expired event is dropped (no delivery, no queue)", async () => {
  const h = harness();
  const e = spool(h.pending, {
    priority: "normal",
    title: "stale",
    spoken: "This is stale.",
    ts: Date.now() - 120 * 60_000, // produced 2h ago
    ttlMinutes: 5, // long expired
  });

  await drainPending(h.deps);

  assert.equal(h.calls.chimes.length, 0);
  assert.equal(h.calls.spoken.length, 0);
  assert.equal(readQueued().some((q) => q.id === e.id), false, "dropped event not queued");
  assert.deepEqual(fs.readdirSync(h.pending), [], "dropped file moved to done/");
});

test("duplicate dedupeKey is processed exactly once", async () => {
  const h = harness();
  // Two files, same dedupeKey. Low priority so both would queue if not deduped.
  const key = "dg:demo-app:held";
  const first = spool(h.pending, { priority: "low", title: "held", spoken: "held once", dedupeKey: key });
  await drainPending(h.deps);
  assert.equal(readQueued().filter((q) => q.dedupeKey === key).length, 1, "first delivery queued");

  const second = spool(h.pending, { priority: "low", title: "held again", spoken: "held twice", dedupeKey: key });
  await drainPending(h.deps);

  const dupes = readQueued().filter((q) => q.dedupeKey === key);
  assert.equal(dupes.length, 1, "second dedupeKey occurrence was NOT queued again");
  assert.notEqual(first.id, second.id);
  // Both files nonetheless moved out of pending/ (the dupe → done/, not stuck).
  assert.deepEqual(fs.readdirSync(h.pending), []);
});

test("critical event triggers a phone push (in addition to speaking)", async () => {
  // Hands accepts the speak; presence stays unknown.
  const h = harness({ handsReply: (a) => (a.action === "presence" ? { ok: false } : { ok: true }) });
  const e = spool(h.pending, {
    priority: "critical",
    title: "prod down",
    spoken: "Production is down.",
    kind: "incident.open",
  });

  await drainPending(h.deps);

  // Policy authorizes the voice for critical; the broker ALSO pushes.
  assert.equal(h.calls.spoken.length, 1, "critical spoke");
  assert.equal(h.calls.pushes.length, 1, "critical also pushed to phone");
  assert.equal(h.calls.pushes[0].priority, "urgent", "critical maps to urgent push priority");
  assert.equal(h.calls.pushes[0].title, "prod down");
  assert.deepEqual(fs.readdirSync(h.pending), []);
});

test("Hands busy on a speak → event requeues (stays in pending/), retried later", async () => {
  // Critical always wants to speak; make Hands report busy the first time.
  let served = 0;
  const h = harness({
    handsReply: (a) => {
      if (a.action === "presence") return { ok: false };
      served++;
      return served === 1 ? { busy: true } : { ok: true };
    },
  });
  const e = spool(h.pending, {
    priority: "critical",
    title: "prod down",
    spoken: "Production is down.",
  });

  await drainPending(h.deps);
  // Busy speak → file must remain in pending/ for a retry, NOT move to done/.
  assert.equal(fs.readdirSync(h.pending).length, 1, "busy speak left the event in pending/");
  assert.equal(fs.readdirSync(h.done).length, 0);
  // But a critical still pushed to the phone even though the voice was deferred.
  assert.equal(h.calls.pushes.length, 1, "critical push fired despite busy voice");
});

test("unparseable spool file is quarantined, not retried forever", async () => {
  const h = harness();
  fs.writeFileSync(path.join(h.pending, "evt-garbage.json"), "{ not valid json");

  await drainPending(h.deps);

  assert.deepEqual(fs.readdirSync(h.pending), [], "garbage file removed from pending/");
  const qDir = path.join(process.cwd(), "data", "events", "quarantine");
  assert.equal(fs.existsSync(qDir) && fs.readdirSync(qDir).length >= 1, true, "garbage moved to quarantine/");
});

test("a delivery record is appended to log.jsonl for a handled event", async () => {
  const h = harness();
  const e = spool(h.pending, { priority: "low", title: "note", spoken: "note" });
  await drainPending(h.deps);

  const logP = path.join(process.cwd(), "data", "events", "log.jsonl");
  const lines = fs.readFileSync(logP, "utf8").split("\n").filter((l) => l.trim());
  const rec = lines.map((l) => JSON.parse(l)).find((r) => r.id === e.id);
  assert.ok(rec, "log line written for the event");
  assert.equal(rec.decision, "queue");
  assert.equal(rec.kind, e.kind);
  assert.equal(typeof rec.reason, "string");
});

/* -------------------------------------------------------------------------- */
/* B3 anticipation — morning greeting (broker bypass) + evening wrap (tick)    */
/* -------------------------------------------------------------------------- */

const ACTIVE: MacPresence = {
  presence: "active",
  idleSeconds: 5,
  screenLocked: false,
  fullscreen: false,
  micActive: false,
};

/** Idle but recently-at-the-desk (well under the 10-min receptive bound). */
const IDLE_RECENT: MacPresence = {
  presence: "idle",
  idleSeconds: 120,
  screenLocked: false,
  fullscreen: false,
  micActive: false,
};

/** Idle long enough to be genuinely away from the desk. */
const IDLE_STALE: MacPresence = {
  presence: "idle",
  idleSeconds: 30 * 60,
  screenLocked: false,
  fullscreen: false,
  micActive: false,
};

/** Locked screen — a hard block regardless of the presence label. */
const LOCKED: MacPresence = {
  presence: "active",
  idleSeconds: 0,
  screenLocked: true,
  fullscreen: false,
  micActive: false,
};

test("REGRESSION: presence.wake at 06:30 SPEAKS the greeting exactly once per day", async () => {
  // The old policy rule 3 (quiet hours hour<8) would have QUEUED this — the
  // whole point of the broker bypass is that the flagship morning moment speaks.
  clearAnticipationLedgers();
  const at0630 = new Date(2026, 0, 15, 6, 30, 0).getTime();
  const h = harness({ presence: null }); // presence unknown → proceed

  await withFixedNow(at0630, async () => {
    spool(h.pending, {
      kind: "presence.wake",
      priority: "normal",
      title: "the owner present",
      spoken: "",
      ttlMinutes: 30,
    });
    await drainPending(h.deps);

    const speaks = h.calls.hands.filter((a) => a.action === "speak");
    assert.equal(speaks.length, 1, "greeting spoke once at 06:30");
    assert.equal(readQueued().length, 0, "greeting was NOT queued (old quiet-hours rule would have)");
    assert.equal(h.calls.spoken.length, 0, "greeting is EXEMPT from the spoken budget");

    // A second wake the same day must NOT re-greet.
    spool(h.pending, {
      kind: "presence.wake",
      priority: "normal",
      title: "the owner present",
      spoken: "",
      ttlMinutes: 30,
    });
    await drainPending(h.deps);
    const speaks2 = h.calls.hands.filter((a) => a.action === "speak");
    assert.equal(speaks2.length, 1, "second wake same day did not re-greet (once-per-day ledger)");
  });
});

test("presence.wake with Mac locked/away → dropped, no greeting", async () => {
  clearAnticipationLedgers();
  const at0700 = new Date(2026, 1, 3, 7, 0, 0).getTime();
  const h = harness({ presence: { ...ACTIVE, presence: "away", screenLocked: true } });

  await withFixedNow(at0700, async () => {
    spool(h.pending, { kind: "presence.wake", priority: "normal", title: "present", spoken: "" });
    await drainPending(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 0, "no greeting when locked/away");
    assert.equal(readQueued().length, 0);
  });
});

test("presence.wake before 06:00 → dropped (too early to greet)", async () => {
  clearAnticipationLedgers();
  const at0500 = new Date(2026, 2, 10, 5, 0, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at0500, async () => {
    spool(h.pending, { kind: "presence.wake", priority: "normal", title: "present", spoken: "" });
    await drainPending(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 0, "no greeting before 06:00");
  });
});

test("evening wrap after 18:00, room receptive → speaks once, consumes budget", async () => {
  clearAnticipationLedgers();
  const at1900 = new Date(2026, 3, 2, 19, 0, 0).getTime();
  const h = harness({ presence: ACTIVE });

  await withFixedNow(at1900, async () => {
    await maybeEveningWrap(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 1, "wrap spoke");
    assert.equal(h.calls.spoken.length, 1, "wrap consumed one spoken-budget unit");

    // Same-day second tick: no repeat (per-date wrap ledger).
    await maybeEveningWrap(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 1, "wrap once per day");
  });
});

test("evening wrap with budget spent → chimes + queues instead of speaking", async () => {
  clearAnticipationLedgers();
  const at2000 = new Date(2026, 3, 3, 20, 0, 0).getTime();
  const h = harness({
    presence: ACTIVE,
    todaysCounts: () => ({ spokenTodayCount: 6, chimeTodayCount: 0, lastSpokenAtMs: null }),
  });

  await withFixedNow(at2000, async () => {
    await maybeEveningWrap(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 0, "no speak when budget spent");
    assert.equal(h.calls.hands.filter((a) => a.action === "chime").length, 1, "chimed instead");
    assert.equal(
      readQueued().some((q) => q.kind === "anticipation.evening_wrap"),
      true,
      "wrap queued for brief-me"
    );
  });
});

test("evening wrap before 18:00 → does nothing", async () => {
  clearAnticipationLedgers();
  const at1700 = new Date(2026, 3, 4, 17, 0, 0).getTime();
  const h = harness({ presence: ACTIVE });

  await withFixedNow(at1700, async () => {
    await maybeEveningWrap(h.deps);
    assert.equal(h.calls.hands.length, 0, "no wrap before 18:00");
  });
});

test("evening wrap: recently-idle (<=10min) counts as receptive → speaks", async () => {
  // The real-world case: the owner is at the desk at 18:00 but reads as "idle"
  // because he isn't actively touching input that second. This must still
  // reach the flagship spoken path, not degrade to the escalation push.
  clearAnticipationLedgers();
  const at1800 = new Date(2026, 3, 10, 18, 0, 0).getTime();
  const h = harness({ presence: IDLE_RECENT });

  await withFixedNow(at1800, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 1, "recently-idle speaks the wrap");
  assert.equal(h.calls.pushes.length, 0, "no escalation push needed");
  assert.equal(readWrapLedger()?.via, "spoken", "terminal: spoken");
});

test("evening wrap: stale-idle (well past the bound) is NOT receptive → chimes, pending, later escalates", async () => {
  clearAnticipationLedgers();
  const at1800 = new Date(2026, 3, 11, 18, 0, 0).getTime();
  const h = harness({ presence: IDLE_STALE });

  await withFixedNow(at1800, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 0, "stale-idle does not speak");
  assert.equal(h.calls.hands.filter((a) => a.action === "chime").length, 1, "chimed instead");
  assert.equal(readWrapLedger()?.via, "pending", "escalation owed, not a silent terminal");

  await withFixedNow(at1800 + ANTICIPATION_ESCALATION_GRACE_MS + 1000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "stale-idle wrap escalates to a phone push");
  assert.equal(readWrapLedger()?.via, "push", "terminal: push");
});

test("evening wrap: screen LOCKED is a hard block regardless of the presence label", async () => {
  // LOCKED carries presence:"active" but screenLocked:true — must still fall
  // through to non-receptive (chime+pending), never speak into a locked screen.
  clearAnticipationLedgers();
  const at1800 = new Date(2026, 3, 12, 18, 0, 0).getTime();
  const h = harness({ presence: LOCKED });

  await withFixedNow(at1800, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 0, "locked screen never speaks");
  assert.equal(h.calls.hands.filter((a) => a.action === "chime").length, 1, "chimed instead");
  assert.equal(readWrapLedger()?.via, "pending", "escalation owed");
});

/* -------------------------------------------------------------------------- */
/* Proactive-delivery escalation — "queued" is never a terminal silent state   */
/* -------------------------------------------------------------------------- */

/** Read the raw evening-wrap ledger JSON straight off disk. */
function readWrapLedger(): { date: string; via?: string; pendingSinceMs?: number } | null {
  const p = path.join(process.cwd(), "data", "events", "evening-wrap-ledger.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function readGreetingLedger(): { date: string; via?: string; pendingSinceMs?: number } | null {
  const p = path.join(process.cwd(), "data", "events", "greeting-ledger.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

test("wrap that chimes (room not receptive) stamps the ledger PENDING, not delivered", async () => {
  clearAnticipationLedgers();
  // 20:00, presence null → room not receptive → chime+queue path.
  const at2000 = new Date(2026, 4, 2, 20, 0, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at2000, async () => {
    await maybeEveningWrap(h.deps);
    assert.equal(h.calls.hands.filter((a) => a.action === "chime").length, 1, "chimed");
    assert.equal(h.calls.pushes.length, 0, "no push yet — inside the grace window");
  });

  const led = readWrapLedger();
  assert.equal(led?.via, "pending", "wrap ledger is pending, not a silent terminal");
  assert.equal(led?.pendingSinceMs, at2000, "escalation clock stamped at the chime moment");
});

test("wrap pending past the grace window → escalates to a phone push, re-stamps terminal", async () => {
  clearAnticipationLedgers();
  const at2000 = new Date(2026, 4, 2, 20, 0, 0).getTime();
  const h = harness({ presence: null });

  // First tick: chime + pending stamp.
  await withFixedNow(at2000, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0);

  // A tick just before the grace elapses → still no push.
  await withFixedNow(at2000 + ANTICIPATION_ESCALATION_GRACE_MS - 60_000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "no push before the grace window elapses");
  assert.equal(readWrapLedger()?.via, "pending", "still pending inside grace");

  // A tick past the grace window → escalate to push.
  await withFixedNow(at2000 + ANTICIPATION_ESCALATION_GRACE_MS + 1000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "escalated to a phone push once grace elapsed");
  assert.equal(h.calls.pushes[0].title, "Evening wrap");
  assert.equal(readWrapLedger()?.via, "push", "ledger re-stamped terminal (push)");

  // A later tick must NOT double-deliver.
  await withFixedNow(at2000 + ANTICIPATION_ESCALATION_GRACE_MS + 10 * 60_000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "terminal push is not repeated");
});

test("wrap non-receptive across many 30s ticks → chimes at most once per re-chime interval, NOT every tick", async () => {
  clearAnticipationLedgers();
  const at2000 = new Date(2026, 4, 2, 20, 0, 0).getTime();
  const { WRAP_RECHIME_INTERVAL_MS } = await import("../lib/anticipation.ts");
  const h = harness({ presence: null });

  // Simulate 20 broker ticks 30s apart (10 minutes) — all inside one re-chime
  // interval. This is the exact shape of the 70-minute incident: the wrap used
  // to chime on every one of these ticks.
  for (let i = 0; i < 20; i++) {
    await withFixedNow(at2000 + i * 30_000, async () => {
      await maybeEveningWrap(h.deps);
    });
  }
  assert.equal(
    h.calls.hands.filter((a) => a.action === "chime").length,
    1,
    "one chime across 20 ticks inside the first re-chime interval, not 20"
  );
  // Queue holds exactly one recap, not one duplicate line per tick.
  assert.equal(
    readQueued().filter((q) => q.kind === "anticipation.evening_wrap").length,
    1,
    "recap queued exactly once, not per tick"
  );

  // A tick past the re-chime interval → one more gentle chime.
  await withFixedNow(at2000 + WRAP_RECHIME_INTERVAL_MS + 1000, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(
    h.calls.hands.filter((a) => a.action === "chime").length,
    2,
    "a second chime only after the re-chime interval elapses"
  );
});

test("wrap re-chimes on later ticks but keeps its escalation clock anchored → still escalates after grace", async () => {
  clearAnticipationLedgers();
  const at2000 = new Date(2026, 4, 2, 20, 0, 0).getTime();
  const h = harness({ presence: null });

  // First pending attempt at 20:00 stamps the escalation clock.
  await withFixedNow(at2000, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(readWrapLedger()?.pendingSinceMs, at2000, "clock anchored at first attempt");

  // Many more non-receptive ticks up to just before the grace window — the clock
  // must NOT be pushed forward by any of them (the tonight-bug regression guard).
  for (let ms = 30_000; ms < ANTICIPATION_ESCALATION_GRACE_MS - 60_000; ms += 30_000) {
    await withFixedNow(at2000 + ms, async () => {
      await maybeEveningWrap(h.deps);
    });
  }
  assert.equal(
    readWrapLedger()?.pendingSinceMs,
    at2000,
    "escalation clock stays anchored at the FIRST attempt across all re-queues"
  );
  assert.equal(readWrapLedger()?.via, "pending", "still pending inside grace");

  // One tick past the grace window → escalation finally fires, exactly as the
  // morning greeting did but the wrap never used to.
  await withFixedNow(at2000 + ANTICIPATION_ESCALATION_GRACE_MS + 1000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "grace elapsed from the FIRST attempt → escalates to a phone push");
  assert.equal(readWrapLedger()?.via, "push", "re-stamped terminal");
});

test("wrap escalation into quiet hours → terminal quiet-hours suppression (no night push, respects policy rule 3)", async () => {
  clearAnticipationLedgers();
  // Chime at 21:30 (waking hour < 22), then the grace elapses AFTER 22:00.
  const at2130 = new Date(2026, 4, 3, 21, 30, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at2130, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(readWrapLedger()?.via, "pending");

  // Grace has elapsed but now it's 22:05 — quiet hours (policy rule 3: hour>=22).
  await withFixedNow(new Date(2026, 4, 3, 22, 5, 0).getTime(), async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "no push inside quiet hours — no night nag");
  // Terminal, but an EXPLICIT quiet-hours suppression — NOT a silent queue death
  // (the recap still sits in queued.jsonl for brief-me). Invariant holds.
  assert.equal(readWrapLedger()?.via, "quiet-suppressed", "terminal quiet-hours suppression");
  assert.equal(
    readQueued().some((q) => q.kind === "anticipation.evening_wrap"),
    true,
    "recap still queued for brief-me despite the night suppression"
  );

  // A later tick (even next morning) must NOT resurrect it — tomorrow gets its own wrap.
  await withFixedNow(new Date(2026, 4, 4, 8, 5, 0).getTime(), async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "quiet-suppressed wrap is terminal, never resurrected");
});

test("a wrap that SPEAKS clears the pending stamp so the escalator never pushes", async () => {
  clearAnticipationLedgers();
  // Not receptive at 20:00 → pending. Then receptive at 20:30 → speaks... but the
  // per-date ledger already marks the wrap done for the day, so speaking again is
  // gated. Instead assert the receptive-first path stamps "spoken" and no push.
  const at1900 = new Date(2026, 4, 5, 19, 0, 0).getTime();
  const h = harness({ presence: ACTIVE });

  await withFixedNow(at1900, async () => {
    await maybeEveningWrap(h.deps);
  });
  assert.equal(readWrapLedger()?.via, "spoken", "receptive wrap stamps spoken (terminal)");

  // Escalator finds a terminal ledger → does nothing.
  await withFixedNow(at1900 + ANTICIPATION_ESCALATION_GRACE_MS + 60_000, async () => {
    await maybeEscalateAnticipation(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "escalator never fires for a spoken wrap");
});

/* -------------------------------------------------------------------------- */
/* Missed-window greeting catch-up                                             */
/* -------------------------------------------------------------------------- */

test("greeting catch-up does nothing before the noon cutoff (a late wake can still speak)", async () => {
  clearAnticipationLedgers();
  const at1030 = new Date(2026, 4, 6, 10, 30, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at1030, async () => {
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "before cutoff → no catch-up push");
  assert.equal(readGreetingLedger(), null, "ledger untouched before cutoff");
});

test("greeting catch-up after cutoff with no wake all day → compact phone push", async () => {
  clearAnticipationLedgers();
  const at1230 = new Date(2026, 4, 6, 12, 30, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at1230, async () => {
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "day is never zero-delivery — compact greeting pushed");
  assert.equal(h.calls.pushes[0].title, "Morning");
  assert.equal(readGreetingLedger()?.via, "push", "greeting ledger stamped terminal (push)");

  // A second tick must not re-push.
  await withFixedNow(at1230 + 60 * 60_000, async () => {
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 1, "catch-up push not repeated");
});

test("greeting catch-up is a no-op once the morning greeting has already been delivered", async () => {
  clearAnticipationLedgers();
  // Greet at 06:30 via the normal wake path, then a post-noon tick.
  const at0630 = new Date(2026, 4, 7, 6, 30, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at0630, async () => {
    spool(h.pending, { kind: "presence.wake", priority: "normal", title: "present", spoken: "", ttlMinutes: 30 });
    await drainPending(h.deps);
  });
  assert.equal(h.calls.hands.filter((a) => a.action === "speak").length, 1, "greeting spoke on wake");

  await withFixedNow(new Date(2026, 4, 7, 12, 30, 0).getTime(), async () => {
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "already greeted → catch-up is a no-op");
});

test("greeting catch-up past cutoff INSIDE quiet hours → terminal quiet-hours suppression (no night push)", async () => {
  clearAnticipationLedgers();
  // A run at 23:00 with no wake all day (Mac was asleep). Past the noon cutoff
  // AND in quiet hours — a "good morning" push at 23:00 is worse than none.
  const at2300 = new Date(2026, 4, 8, 23, 0, 0).getTime();
  const h = harness({ presence: null });

  await withFixedNow(at2300, async () => {
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "no greeting push at 23:00 (quiet hours)");
  // Terminal quiet-hours suppression — not silent, and not carried to tomorrow
  // (tomorrow's first presence.wake gets its own fresh greeting).
  assert.equal(readGreetingLedger()?.via, "quiet-suppressed", "terminal quiet-hours suppression");

  await withFixedNow(new Date(2026, 4, 9, 8, 5, 0).getTime(), async () => {
    await maybeEscalateAnticipation(h.deps);
    await maybeGreetingCatchup(h.deps);
  });
  assert.equal(h.calls.pushes.length, 0, "suppressed greeting is terminal for that day, never resurrected");
});
