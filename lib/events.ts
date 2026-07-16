import fs from "node:fs";
import path from "node:path";

import type {
  VidiEvent,
  PolicyInputs,
  PresenceState,
  Presence,
  EventPriority,
} from "./events-types.ts";
import {
  EVENTS_SPOOL_PENDING,
  EVENTS_SPOOL_DONE,
  MAX_SPOKEN_PER_DAY,
} from "./events-types.ts";
import { dataPath } from "./data-dir.ts";
import { decide, recordSpoken, recordChime, todaysCounts } from "./policy.ts";
import { pushToPhone, type PushPriority } from "./push.ts";
import { isQuiet } from "./quiet.ts";
import { handsAct } from "./hands.ts";
import { getMacPresence, type MacPresence } from "./context.ts";
import {
  buildGreeting,
  buildCompactGreeting,
  greetingDeliveredToday,
  recordGreeting,
  isInMeeting,
  eveningWrapDeliveredToday,
  eveningWrapLedgerToday,
  recordEveningWrap,
  recordEveningWrapPending,
  shouldChimeEveningWrap,
  noUnpromptedSpeechSince,
  buildEveningWrap,
  ANTICIPATION_ESCALATION_GRACE_MS,
  GREETING_CATCHUP_CUTOFF_HOUR,
  WRAP_RECEPTIVE_IDLE_MAX_SECONDS,
} from "./anticipation.ts";

/**
 * The proactivity BROKER: the one place that turns spooled VidiEvents into
 * actual delivery. Producers (ops jobs, the /api/events route, the Swift app)
 * only ever write files into EVENTS_SPOOL_PENDING; this loop is the sole reader
 * and mover. It gathers the live world into PolicyInputs, asks the pure policy
 * (lib/policy.ts) how loudly to deliver, then actuates via Hands (speak/chime),
 * the phone push channel, or the queue.
 *
 * Fail-open is the governing rule: this runs adjacent to voice turns and must
 * never throw into one. Every event is processed inside its own try/catch, a
 * single poisoned file can't stall the loop, and a broken dependency degrades
 * (null presence, requeue, drop) rather than propagating.
 */

/* -------------------------------------------------------------------------- */
/* Dependency-injection seam                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The broker's side-effecting collaborators, bundled so tests can substitute
 * fakes without spawning anything real (no Hands server on :4184, no notify.py
 * subprocess). Production callers use the defaults; only tests pass overrides.
 *
 * `dirs` is here too because EVENTS_SPOOL_PENDING/DONE are ABSOLUTE paths
 * baked into the frozen contract — chdir can't redirect them into a temp dir
 * the way it can for the cwd-based data/ ledger, so tests point them explicitly.
 */
export interface BrokerDeps {
  handsAct: (action: Record<string, unknown>) => Promise<any>;
  pushToPhone: (
    title: string,
    body: string,
    priority: PushPriority
  ) => Promise<boolean>;
  isQuiet: () => boolean;
  recordSpoken: (ts: number) => void;
  recordChime: (ts: number) => void;
  todaysCounts: (now: Date) => {
    spokenTodayCount: number;
    chimeTodayCount: number;
    lastSpokenAtMs: number | null;
  };
  /** Mac presence for the anticipation moments (morning greeting / evening
   *  wrap). Null = unknown; each moment decides how to treat that. */
  getMacPresence: () => Promise<MacPresence | null>;
  dirs: { pending: string; done: string };
}

function defaultDeps(): BrokerDeps {
  return {
    handsAct,
    pushToPhone,
    isQuiet,
    recordSpoken,
    recordChime,
    todaysCounts,
    getMacPresence,
    dirs: { pending: EVENTS_SPOOL_PENDING, done: EVENTS_SPOOL_DONE },
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence paths (cwd-based data/, so tests chdir a temp dir)             */
/* -------------------------------------------------------------------------- */

function eventsDataDir(): string {
  // Shared dataDir() (VIDI_DATA_DIR override, else <cwd>/data) — unset resolves
  // byte-identically to <cwd>/data/events.
  return dataPath("events");
}
function dedupePath(): string {
  return path.join(eventsDataDir(), "seen-dedupe.json");
}
function queuedPath(): string {
  return path.join(eventsDataDir(), "queued.jsonl");
}
function logPath(): string {
  return path.join(eventsDataDir(), "log.jsonl");
}
function quarantineDir(): string {
  return path.join(eventsDataDir(), "quarantine");
}

/* -------------------------------------------------------------------------- */
/* Dedupe ledger — persisted so a restart mid-storm doesn't re-deliver        */
/* -------------------------------------------------------------------------- */

/**
 * In-memory mirror of the on-disk dedupe set, so the hot path is a Set lookup
 * and we only touch disk to persist a newly-seen key. Loaded lazily on first
 * use and kept alive on globalThis so HMR doesn't reset it under us.
 */
function seenSet(): Set<string> {
  const g = globalThis as Record<string, any>;
  if (!g.__vidiBrokerSeen) {
    let loaded: string[] = [];
    try {
      loaded = JSON.parse(fs.readFileSync(dedupePath(), "utf8"));
      if (!Array.isArray(loaded)) loaded = [];
    } catch {
      // Missing file on a fresh install is the normal case, not an error.
    }
    g.__vidiBrokerSeen = new Set(loaded);
  }
  return g.__vidiBrokerSeen as Set<string>;
}

function markSeen(dedupeKey: string): void {
  const set = seenSet();
  if (set.has(dedupeKey)) return;
  set.add(dedupeKey);
  try {
    fs.mkdirSync(eventsDataDir(), { recursive: true });
    // Rewrite the whole set: it stays small (only unresolved dedupe keys) and a
    // full rewrite via temp+rename can't leave a torn file for the next reader.
    const tmp = dedupePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...set]));
    fs.renameSync(tmp, dedupePath());
  } catch {
    // Fail-open: losing a dedupe persist at worst re-delivers one event after a
    // restart — far better than throwing out of the broker loop.
  }
}

/* -------------------------------------------------------------------------- */
/* Presence — best-effort snapshot from the Mac app                           */
/* -------------------------------------------------------------------------- */

/**
 * Ask Hands for a live presence snapshot. The Swift /act "presence" verb is
 * live and returns real presence data; this still degrades to null on any
 * failure/unknown reply (Hands down, malformed response), which the policy
 * treats conservatively (never assumes a listener). Returning null on ANY
 * failure is deliberate: presence is an optimization, never a gate we can
 * afford to crash on.
 */
async function getPresence(deps: BrokerDeps): Promise<PresenceState | null> {
  try {
    const reply = await deps.handsAct({ action: "presence" });
    if (!reply || reply.ok === false) return null;
    // Accept either a top-level shape or a nested { presence: {...} } envelope.
    const p = (reply.presence && typeof reply.presence === "object" && "idleSeconds" in reply.presence)
      ? reply.presence
      : reply;
    const presence: Presence =
      p.presence === "active" || p.presence === "idle" || p.presence === "away"
        ? p.presence
        : "active";
    return {
      presence,
      idleSeconds: typeof p.idleSeconds === "number" ? p.idleSeconds : 0,
      screenLocked: p.screenLocked === true,
      fullscreen: p.fullscreen === true,
      micActive: p.micActive === true,
      frontmostApp: typeof p.frontmostApp === "string" ? p.frontmostApp : undefined,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Map the event's EventPriority onto the phone push channel's own scale. */
function mapPriority(p: EventPriority): PushPriority {
  switch (p) {
    case "critical":
      return "urgent";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "default";
  }
}

function appendJsonl(file: string, record: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
  } catch {
    // Losing a log/queue line must never break delivery. Swallow and move on.
  }
}

/** Move a processed spool file into done/. Best-effort — if the source is gone
 *  (already moved by a racing tick) or the move fails, we just drop it. */
function moveToDone(deps: BrokerDeps, filename: string): void {
  try {
    fs.mkdirSync(deps.dirs.done, { recursive: true });
    fs.renameSync(
      path.join(deps.dirs.pending, filename),
      path.join(deps.dirs.done, filename)
    );
  } catch {
    /* file already gone or undeletable — nothing more we can do safely */
  }
}

/** Isolate an unparseable spool file so it stops re-tripping the loop, without
 *  deleting evidence a human might want. */
function quarantine(deps: BrokerDeps, filename: string): void {
  try {
    fs.mkdirSync(quarantineDir(), { recursive: true });
    fs.renameSync(
      path.join(deps.dirs.pending, filename),
      path.join(quarantineDir(), filename)
    );
  } catch {
    /* couldn't move it — leave it; the parse guard skips it next tick too */
  }
}

/* -------------------------------------------------------------------------- */
/* Backoff bookkeeping for requeued (busy Hands) events                       */
/* -------------------------------------------------------------------------- */

/**
 * When Hands is busy we leave the file in pending/ and retry on a later tick.
 * To avoid hammering a stuck Hands server every 30s forever, we track per-file
 * attempts + the next-eligible time in memory and skip a file until its backoff
 * elapses. This is intentionally in-memory only: a restart clears it, which is
 * the correct behavior (a fresh process should retry immediately).
 */
interface RetryState {
  attempts: number;
  nextEligibleMs: number;
}
function retryTable(): Map<string, RetryState> {
  const g = globalThis as Record<string, any>;
  return (g.__vidiBrokerRetry ??= new Map<string, RetryState>());
}

/** Bounded exponential-ish backoff, capped so a wedged Hands server is retried
 *  at most every ~5 minutes rather than never. */
function scheduleRetry(filename: string): void {
  const table = retryTable();
  const prev = table.get(filename);
  const attempts = (prev?.attempts ?? 0) + 1;
  const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** (attempts - 1));
  table.set(filename, { attempts, nextEligibleMs: Date.now() + delayMs });
}
function clearRetry(filename: string): void {
  retryTable().delete(filename);
}
function isBackedOff(filename: string): boolean {
  const s = retryTable().get(filename);
  return s !== undefined && Date.now() < s.nextEligibleMs;
}

/* -------------------------------------------------------------------------- */
/* B3 anticipation — morning greeting (broker bypass) + evening wrap (tick)    */
/* -------------------------------------------------------------------------- */

/**
 * The morning greeting: fired by the first presence.wake of the day. This is a
 * DOCUMENTED broker bypass — it does NOT go through decide() and is EXEMPT from
 * both the daily spoken budget and the quiet-hours rule. That exemption is the
 * whole point: the ordinary policy (policy.ts rule 3) would QUEUE a 6–8am
 * greeting into oblivion, killing the flagship "good morning" moment. We instead
 * gate on our own, narrower conditions and speak directly.
 *
 * Guards, in order:
 *   1. already greeted today  → drop (once-per-day via the greeting ledger),
 *   2. before 06:00 local     → drop (too early to be a greeting),
 *   3. Mac explicitly locked/away → drop (null/unknown presence PROCEEDS — the
 *      wake itself is strong evidence someone's here).
 *
 * The greeting ledger is written BEFORE the speak call so a crash between the
 * two under-speaks (misses one greeting) rather than over-speaks (repeats it).
 */
async function handlePresenceWake(
  deps: BrokerDeps,
  event: VidiEvent,
  filename: string
): Promise<void> {
  const now = new Date();
  const drop = (reason: string) => {
    appendJsonl(logPath(), {
      ts: Date.now(),
      id: event.id,
      kind: event.kind,
      decision: "drop",
      reason,
    });
    moveToDone(deps, filename);
  };

  if (greetingDeliveredToday(now)) {
    return drop("presence.wake: already greeted today");
  }
  if (now.getHours() < 6) {
    return drop("presence.wake: before 06:00 local");
  }

  let presence: MacPresence | null = null;
  try {
    presence = await deps.getMacPresence();
  } catch {
    presence = null; // unknown → proceed (the wake implies presence)
  }
  if (presence && (presence.screenLocked || presence.presence === "away")) {
    return drop("presence.wake: Mac locked/away");
  }

  // Compose zero-LLM and record the ledger BEFORE speaking (crash → under-speak).
  const spoken = buildGreeting(now);
  recordGreeting(now);
  await deps.handsAct({ action: "speak", text: spoken, priority: "high" });
  appendJsonl(logPath(), {
    ts: Date.now(),
    id: event.id,
    kind: event.kind,
    decision: "speak",
    reason: "presence.wake: morning greeting (budget + quiet-hours exempt)",
  });
  moveToDone(deps, filename);
}

/**
 * The evening wrap: once per day, on the broker's 30s tick. At the first tick
 * after 18:00 (not yet wrapped today) we recap due/open commitments + queued
 * titles. If the room is genuinely receptive — presence known and not locked,
 * either actively-in-use or idle for no more than WRAP_RECEPTIVE_IDLE_MAX_SECONDS
 * (recently-at-the-desk idle, not away-from-desk idle) — plus no unprompted
 * speech since 16:00 and spoken budget remaining, we SPEAK it; otherwise we
 * soften to a chime and drop it in the queue for brief-me (the escalation path
 * in maybeEscalateAnticipation is the net for a genuinely-away evening). Either
 * way the per-date wrap ledger is stamped so it happens exactly once.
 *
 * Like the greeting, the ledgers (wrap ledger + the spoken-budget entry) are
 * written BEFORE the speak call, so a crash under-speaks rather than over-speaks.
 */
export async function maybeEveningWrap(
  deps: BrokerDeps = defaultDeps(),
  now: Date = new Date()
): Promise<void> {
  try {
    if (eveningWrapDeliveredToday(now)) return;
    if (now.getHours() < 18) return;

    let presence: MacPresence | null = null;
    try {
      presence = await deps.getMacPresence();
    } catch {
      presence = null;
    }
    // screenLocked is always a hard block regardless of the presence label.
    // "active" is obviously receptive; "idle" still counts as receptive up to
    // WRAP_RECEPTIVE_IDLE_MAX_SECONDS — the owner reads as idle at 18:00 while
    // sitting at the desk not touching input, which is not the same as away.
    const active =
      presence !== null &&
      !presence.screenLocked &&
      (presence.presence === "active" ||
        (presence.presence === "idle" && presence.idleSeconds <= WRAP_RECEPTIVE_IDLE_MAX_SECONDS));

    const since4pm = new Date(now);
    since4pm.setHours(16, 0, 0, 0);
    const quietSince4pm = noUnpromptedSpeechSince(since4pm.getTime());

    const budgetLeft = deps.todaysCounts(now).spokenTodayCount < MAX_SPOKEN_PER_DAY;
    const spoken = buildEveningWrap(now);

    if (active && quietSince4pm && budgetLeft) {
      // Record ledgers BEFORE speaking (crash → under-speak). The wrap consumes
      // one unit of the ordinary spoken budget, unlike the exempt greeting.
      recordEveningWrap(now);
      deps.recordSpoken(now.getTime());
      await deps.handsAct({ action: "speak", text: spoken, priority: "normal" });
      appendJsonl(logPath(), {
        ts: Date.now(),
        kind: "anticipation.evening_wrap",
        decision: "speak",
        reason: "evening wrap: room receptive",
      });
      return;
    }

    // Not a good moment — chime softly and queue for brief-me instead of nagging.
    // Stamp the ledger PENDING (not terminal): the escalator on a later tick owes
    // this a phone push if the room never becomes receptive, so a chime is no
    // longer a silent queue death.
    //
    // The wrap rides the broker's 30s tick, so BOTH clocks must be guarded or the
    // tick becomes a metronome: (1) chime at most once per WRAP_RECHIME_INTERVAL_MS
    // (shouldChimeEveningWrap), and (2) keep the escalation clock anchored at the
    // FIRST attempt (recordEveningWrapPending is idempotent). Without these guards
    // the wrap re-chimed every 30s AND reset its own escalation clock every tick,
    // so it never escalated — the 70-minute 30s-chime incident on 2026-07-07.
    const priorPending = eveningWrapLedgerToday(now)?.via === "pending";
    const chimeNow = shouldChimeEveningWrap(now);
    recordEveningWrapPending(now, chimeNow);
    if (chimeNow) {
      await deps.handsAct({ action: "chime", text: spoken });
      // Queue the recap exactly once — on the first pending attempt — so brief-me
      // sees a single entry, not one duplicate line per tick.
      if (!priorPending) {
        appendJsonl(queuedPath(), {
          id: `evt-evening-wrap-${now.getFullYear()}${now.getMonth() + 1}${now.getDate()}`,
          ts: now.getTime(),
          source: "anticipation",
          kind: "anticipation.evening_wrap",
          priority: "normal",
          title: "Evening wrap",
          spoken,
          ttlMinutes: 720,
        });
      }
      appendJsonl(logPath(), {
        ts: Date.now(),
        kind: "anticipation.evening_wrap",
        decision: "chime",
        reason: priorPending
          ? "evening wrap: room still not receptive; re-chimed (escalation still owed)"
          : "evening wrap: room not receptive; chimed + queued (escalation owed)",
      });
    }
  } catch {
    // Fail-open like every other broker path — an evening wrap must never throw
    // into the tick and stall the spool drain.
  }
}

/**
 * Quiet hours mirror policy.ts rule (3) EXACTLY (22:00–07:59 local). The
 * anticipation escalator must respect the same night window the policy defines
 * — an owed push waits until morning rather than buzzing the phone at night.
 * Don't widen this; the morning greeting keeps its own separate quiet-hours
 * exemption in handlePresenceWake and this must not leak into that.
 */
function inQuietHours(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 22 || hour < 8;
}

/**
 * The anticipation ESCALATOR: rides the same tick as maybeEveningWrap. Its one
 * job is to enforce the invariant that an anticipation event never dies as a
 * silent queue — a chimed-but-unspoken greeting or wrap that has sat "pending"
 * past the grace window terminates in a phone push instead.
 *
 * For each of the two anticipation ledgers, if today's stamp is "pending" and
 * the grace window has elapsed:
 *   - inside quiet hours → leave it pending (the push waits for morning); the
 *     invariant still holds because the ledger stays pending, not silently done;
 *   - otherwise → push the compact copy to the phone and re-stamp the ledger
 *     "push" (terminal), so it can't double-deliver on a later tick.
 *
 * A speak that lands first (room became receptive) overwrites the pending stamp
 * with "spoken" before this ever fires, so there's no double-delivery race.
 */
export async function maybeEscalateAnticipation(
  deps: BrokerDeps = defaultDeps(),
  now: Date = new Date()
): Promise<void> {
  try {
    // Evening wrap escalation.
    const wrap = eveningWrapLedgerToday(now);
    if (
      wrap &&
      wrap.via === "pending" &&
      typeof wrap.pendingSinceMs === "number" &&
      now.getTime() - wrap.pendingSinceMs >= ANTICIPATION_ESCALATION_GRACE_MS
    ) {
      if (inQuietHours(now)) {
        // Grace elapsed but we're into local night: a phone push now would be
        // the very nag quiet hours exist to prevent. This is a terminal state —
        // an EXPLICIT quiet-hours suppression, not a silent queue death. The
        // recap already sits in the queue for brief-me tomorrow. Not carried to
        // next morning: tomorrow gets its own wrap.
        recordEveningWrap(now, "quiet-suppressed");
        appendJsonl(logPath(), {
          ts: Date.now(),
          kind: "anticipation.evening_wrap",
          decision: "drop",
          reason: "evening wrap: grace elapsed but into quiet hours; suppressed for the night (queued for brief-me)",
        });
      } else {
        const spoken = buildEveningWrap(now);
        // Re-stamp terminal BEFORE the push (crash → under-deliver, never repeat).
        recordEveningWrap(now, "push");
        await deps.pushToPhone("Evening wrap", spoken, "default");
        appendJsonl(logPath(), {
          ts: Date.now(),
          kind: "anticipation.evening_wrap",
          decision: "push",
          reason: "evening wrap: grace window elapsed while room stayed non-receptive; escalated to phone push",
        });
      }
    }
  } catch {
    // Fail-open like every other broker path — never throw into the tick.
  }
}

/**
 * The missed-window GREETING CATCH-UP: also rides the tick. If the once-per-day
 * greeting was never delivered (no presence.wake all morning — Mac asleep or the
 * app launched late), this ensures the day is never zero-delivery:
 *
 *   - before the catch-up cutoff hour → do nothing; a late presence.wake or
 *     app-launch will still speak the greeting the normal way (handlePresenceWake
 *     has no upper hour bound). This preserves the flagship spoken "good morning".
 *   - at/after the cutoff (default noon), with still nothing delivered → deliver
 *     a compact greeting via phone push and stamp the ledger "push". Inside quiet
 *     hours the push waits: stamp "pending" so maybeEscalateAnticipation delivers
 *     it once morning quiet-hours lift, keeping the never-silent invariant.
 *
 * Uses the SAME greeting ledger as handlePresenceWake, so once either path
 * delivers, the other is a no-op for the rest of the day.
 */
export async function maybeGreetingCatchup(
  deps: BrokerDeps = defaultDeps(),
  now: Date = new Date()
): Promise<void> {
  try {
    if (greetingDeliveredToday(now)) return; // already spoken or pushed today
    if (now.getHours() < GREETING_CATCHUP_CUTOFF_HOUR) return; // wake path still has time

    if (inQuietHours(now)) {
      // Past the cutoff but into local night (e.g. Mac was asleep until 22:00+):
      // a "good morning" push at night is worse than none. Terminal EXPLICIT
      // quiet-hours suppression — not a silent death, and not carried to
      // tomorrow (tomorrow's first wake gets its own greeting).
      recordGreeting(now, "quiet-suppressed");
      appendJsonl(logPath(), {
        ts: Date.now(),
        kind: "anticipation.morning_greeting",
        decision: "drop",
        reason: "greeting catch-up: cutoff passed but into quiet hours; suppressed for the night",
      });
      return;
    }
    // Stamp terminal BEFORE the push (crash → under-deliver, never a repeat).
    const compact = buildCompactGreeting(now);
    recordGreeting(now, "push");
    await deps.pushToPhone("Morning", compact, "default");
    appendJsonl(logPath(), {
      ts: Date.now(),
      kind: "anticipation.morning_greeting",
      decision: "push",
      reason: "greeting catch-up: no presence.wake by cutoff; delivered compact greeting via phone push",
    });
  } catch {
    // Fail-open like every other broker path — never throw into the tick.
  }
}

/* -------------------------------------------------------------------------- */
/* Core: process a single spool file                                          */
/* -------------------------------------------------------------------------- */

/**
 * Handle exactly one pending spool file. Returns nothing; every terminal path
 * either moves the file to done/ (delivered/queued/dropped/quarantined) or
 * leaves it in pending/ for a later retry (Hands busy). Never throws.
 */
export async function processFile(deps: BrokerDeps, filename: string): Promise<void> {
  const fullPath = path.join(deps.dirs.pending, filename);

  // Parse — an unreadable/corrupt file is quarantined, not retried forever.
  let event: VidiEvent;
  try {
    event = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    quarantine(deps, filename);
    return;
  }

  // Dedupe: a still-unresolved repeat of an already-handled key is dropped.
  if (event.dedupeKey && seenSet().has(event.dedupeKey)) {
    moveToDone(deps, filename);
    appendJsonl(logPath(), {
      ts: Date.now(),
      id: event.id,
      kind: event.kind,
      decision: "drop",
      reason: "duplicate dedupeKey already seen",
    });
    return;
  }

  // presence.wake is NOT a normal event — it's the trigger for the morning
  // greeting, handled BEFORE decide() and deliberately OUTSIDE the politeness
  // policy (see handlePresenceWake for the documented budget/quiet-hours bypass).
  if (event.kind === "presence.wake") {
    await handlePresenceWake(deps, event, filename);
    return;
  }

  // Gather the world into PolicyInputs. Every gatherer is fail-open on its own.
  const now = new Date();
  const presence = await getPresence(deps);
  // A live meeting is read from the senses calendar page; fail-open false, which
  // only ever makes us LOUDER, and the daily budget still caps the blast radius.
  const inMeeting = isInMeeting(now);
  let dndOrQuiet = false;
  try {
    dndOrQuiet = deps.isQuiet();
  } catch {
    dndOrQuiet = false; // fail-open to "not quiet" (safe failure is speaking)
  }
  const counts = deps.todaysCounts(now);

  const inputs: PolicyInputs = {
    now,
    presence,
    inMeeting,
    dndOrQuiet,
    spokenTodayCount: counts.spokenTodayCount,
    lastSpokenAtMs: counts.lastSpokenAtMs,
    chimeTodayCount: counts.chimeTodayCount,
  };

  const decision = decide(event, inputs);

  // Act on the decision. A "requeue" (Hands busy/unreachable) is the only path
  // that leaves the file in pending/; everything else is terminal.
  let requeue = false;

  switch (decision.deliver) {
    case "speak": {
      const reply = await deps.handsAct({
        action: "speak",
        text: event.spoken,
        priority: event.priority,
      });
      if (!reply || reply.busy === true || reply.ok === false) {
        requeue = true;
      } else {
        deps.recordSpoken(now.getTime());
      }
      break;
    }
    case "chime": {
      const reply = await deps.handsAct({ action: "chime", text: event.spoken });
      if (!reply || reply.busy === true || reply.ok === false) {
        requeue = true;
      } else {
        deps.recordChime(now.getTime());
      }
      break;
    }
    case "push": {
      await deps.pushToPhone(event.title, event.spoken, mapPriority(event.priority));
      break;
    }
    case "queue": {
      appendJsonl(queuedPath(), event);
      break;
    }
    case "drop":
      // Nothing to actuate — the file still moves to done/ below.
      break;
  }

  // A critical event ALSO hits the phone regardless of the primary channel, so
  // the one alert the owner must not miss reaches him even if he's away from the
  // speaker. (When the primary channel WAS push, this is a harmless second push
  // on the same channel; correctness beats de-dup for criticals.)
  if (event.priority === "critical") {
    try {
      await deps.pushToPhone(event.title, event.spoken, mapPriority(event.priority));
    } catch {
      /* fail-open: the critical push is best-effort like every other send */
    }
  }

  if (requeue) {
    scheduleRetry(filename);
    return; // leave in pending/ — a later tick retries after the backoff
  }

  // Terminal: record, mark dedupe (for delivered/queued outcomes), move to done.
  clearRetry(filename);
  appendJsonl(logPath(), {
    ts: Date.now(),
    id: event.id,
    kind: event.kind,
    decision: decision.deliver,
    reason: decision.reason,
  });
  if (event.dedupeKey && decision.deliver !== "drop") {
    markSeen(event.dedupeKey);
  }
  moveToDone(deps, filename);
}

/* -------------------------------------------------------------------------- */
/* Sweep: process all pending files oldest-first                              */
/* -------------------------------------------------------------------------- */

/**
 * Drain the pending spool once. Files are handled oldest-first (by mtime, then
 * name) so an event storm is delivered in roughly the order it was produced.
 * Serialized (awaited one at a time) so the daily budget counts stay coherent —
 * two concurrent "speak"s must not both read the pre-increment count and slip
 * past the cap together. Never throws; a single bad file is isolated.
 */
export async function drainPending(deps: BrokerDeps = defaultDeps()): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(deps.dirs.pending, { withFileTypes: true });
  } catch {
    return; // pending/ doesn't exist yet — nothing to do
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".tmp.json"))
    .map((e) => e.name)
    // Skip files still in backoff so a wedged Hands server isn't hammered.
    .filter((name) => !isBackedOff(name));

  // Oldest-first by mtime; fall back to name for a stable tiebreak.
  files.sort((a, b) => {
    let ma = 0;
    let mb = 0;
    try {
      ma = fs.statSync(path.join(deps.dirs.pending, a)).mtimeMs;
    } catch {
      /* stat race — treat as oldest */
    }
    try {
      mb = fs.statSync(path.join(deps.dirs.pending, b)).mtimeMs;
    } catch {
      /* stat race — treat as oldest */
    }
    return ma - mb || a.localeCompare(b);
  });

  for (const filename of files) {
    try {
      await processFile(deps, filename);
    } catch {
      // Belt-and-suspenders: processFile is already fully guarded, but a bug
      // there must still never stop the drain from reaching the next event.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle: start the watcher + poll fallback (idempotent)                  */
/* -------------------------------------------------------------------------- */

/**
 * Start the broker. Idempotent via a globalThis flag so next-dev HMR (which
 * re-runs modules) can't spin up a second watcher/interval pair. Wakes on:
 *   - fs.watch(pending) — immediate, but macOS drops events under load, so it
 *     is only a latency optimization, never the sole trigger;
 *   - a 30s setInterval poll — the real guarantee that nothing sits forever.
 * Every wake calls drainPending, whose own guards make a concurrent double-wake
 * harmless (files are moved out of pending/ as they're handled).
 */
export function startEventBroker(deps: BrokerDeps = defaultDeps()): void {
  const g = globalThis as Record<string, any>;
  if (g.__vidiBrokerStarted) return;
  g.__vidiBrokerStarted = true;

  // Ensure the pending dir exists so fs.watch has something to watch (and the
  // producers have somewhere to write). Best-effort.
  try {
    fs.mkdirSync(deps.dirs.pending, { recursive: true });
  } catch {
    /* if we can't even mkdir, the poll below still tries readdir each tick */
  }

  // A tiny guard so overlapping wakes (watch + interval firing together) don't
  // run two drains at once and double-count budgets. Serialize onto one chain.
  let draining: Promise<void> = Promise.resolve();
  const kick = () => {
    draining = draining
      .catch(() => {})
      .then(() => drainPending(deps))
      // The evening wrap rides the same serialized chain as the spool drain so
      // it can't race a "speak" past the budget. Its own per-date ledger and
      // time gate keep it to one delivery per day regardless of tick frequency.
      .then(() => maybeEveningWrap(deps))
      // Then the missed-window greeting catch-up and the escalator: both are
      // idempotent via the per-date ledgers, so a double-tick can't double-send.
      // Ordered after the wrap so a wrap that speaks this tick clears its own
      // pending stamp before the escalator would see it.
      .then(() => maybeGreetingCatchup(deps))
      .then(() => maybeEscalateAnticipation(deps))
      .catch(() => {});
  };

  try {
    const watcher = fs.watch(deps.dirs.pending, () => kick());
    watcher.on("error", () => {
      /* watcher died (dir removed?) — the poll keeps us alive; swallow */
    });
    g.__vidiBrokerWatcher = watcher; // pin so it isn't GC'd
  } catch {
    // fs.watch can throw on some platforms/paths — the poll below is the
    // guaranteed fallback, so a missing watcher is survivable.
  }

  const interval = setInterval(kick, 30_000);
  // Don't keep the event loop alive just for the poll (matters for tests / CLI).
  if (typeof interval.unref === "function") interval.unref();
  g.__vidiBrokerInterval = interval;

  // Drain once at startup so anything spooled while we were down is handled now.
  kick();
}
