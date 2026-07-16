import fs from "node:fs";
import path from "node:path";

import { dataPath } from "./data-dir.ts";
import type { VidiEvent, PolicyInputs, PolicyDecision } from "./events-types.ts";
import {
  MAX_SPOKEN_PER_DAY,
  MIN_SPOKEN_SPACING_MS,
  MAX_CHIME_PER_DAY,
} from "./events-types.ts";

/**
 * The politeness policy: given a produced event and the world the broker
 * gathered, decide HOW loudly to deliver it. This is the make-or-break dial
 * for whether Vidi feels like a helpful colleague or a nagging notification
 * spammer, so the rules are ordered, first-match-wins, and each carries a
 * reason string we log for tuning.
 *
 * decide() is deliberately pure — no fs, no Date.now, no I/O. The broker
 * gathers PolicyInputs (including the spoken-budget counts from the ledger
 * below), calls decide(), delivers, then records. Purity is what lets the
 * tests exercise every rule row with a frozen `now`.
 */

/** Speaking budget verdicts collapse to one of these when a "speak" is denied. */
function downgradeSpeak(inputs: PolicyInputs, reason: string): PolicyDecision {
  // Prefer a soft chime over silence, but only while we still have chime
  // budget — otherwise the poke itself becomes the nag we were avoiding.
  if (inputs.chimeTodayCount < MAX_CHIME_PER_DAY) {
    return { deliver: "chime", reason };
  }
  return { deliver: "queue", reason: reason + "; chime budget spent too, queueing" };
}

export function decide(event: VidiEvent, inputs: PolicyInputs): PolicyDecision {
  const nowMs = inputs.now.getTime();
  const isHigh = event.priority === "high";

  // (1) TTL — a stale event is worse than no event; never surface it late.
  if (nowMs > event.ts + event.ttlMinutes * 60000) {
    return { deliver: "drop", reason: "TTL expired; event is stale" };
  }

  // (2) Critical always speaks. The broker also pushes criticals on a
  // separate channel; policy's job here is only to authorize the voice.
  if (event.priority === "critical") {
    return { deliver: "speak", reason: "critical priority always speaks" };
  }

  // (3) Quiet hours — local night. Nothing routine wakes the room; high
  // priority still reaches the phone quietly, everything else waits.
  const hour = inputs.now.getHours();
  if (hour >= 22 || hour < 8) {
    return isHigh
      ? { deliver: "push", reason: "quiet hours; high priority pushed to phone" }
      : { deliver: "queue", reason: "quiet hours; queued for morning" };
  }

  // (4) Empty room — screen locked or long-idle means nobody is there to hear
  // us. Only checked when presence is actually known; a null presence must not
  // let us assume a listener, but also must not fabricate an empty room here.
  if (inputs.presence !== null && (inputs.presence.screenLocked || inputs.presence.idleSeconds > 900)) {
    return isHigh
      ? { deliver: "push", reason: "user away (locked/idle); high priority pushed" }
      : { deliver: "queue", reason: "user away (locked/idle); queued" };
  }

  // (5) Presenting — a live meeting, a fullscreen app, or a hot mic all mean
  // interrupting would be rude or leak into a call. inMeeting comes from the
  // calendar (inputs), the rest from the live presence snapshot.
  if (
    inputs.presence !== null &&
    (inputs.inMeeting || inputs.presence.fullscreen || inputs.presence.micActive)
  ) {
    return isHigh
      ? { deliver: "push", reason: "presenting (meeting/fullscreen/mic); high priority pushed" }
      : { deliver: "queue", reason: "presenting (meeting/fullscreen/mic); queued" };
  }

  // (6) Explicit DND / quiet mode — the user asked for silence.
  if (inputs.dndOrQuiet) {
    return isHigh
      ? { deliver: "push", reason: "DND/quiet mode; high priority pushed" }
      : { deliver: "queue", reason: "DND/quiet mode; queued" };
  }

  // (7) Speech budget — even when everything else says "speak", stay under the
  // daily cap and the spacing window so unprompted speech feels rare and
  // considered. A denied speak softens to a chime (if chime budget remains).
  const wouldExceedDaily = inputs.spokenTodayCount >= MAX_SPOKEN_PER_DAY;
  const tooSoon =
    inputs.lastSpokenAtMs !== null &&
    nowMs - inputs.lastSpokenAtMs < MIN_SPOKEN_SPACING_MS;
  if (wouldExceedDaily || tooSoon) {
    const why = wouldExceedDaily
      ? "daily speech budget reached"
      : "spoke too recently (spacing window)";
    return downgradeSpeak(inputs, why);
  }

  // (8) Default by priority when the room is clear and budget allows.
  if (isHigh) return { deliver: "speak", reason: "default: high priority speaks" };
  if (event.priority === "normal") return { deliver: "chime", reason: "default: normal priority chimes" };
  return { deliver: "queue", reason: "default: low priority queued" };
}

/* -------------------------------------------------------------------------- */
/* Spoken-budget ledger                                                       */
/* -------------------------------------------------------------------------- */

interface LedgerEntry {
  ts: number;
  kind: "speak" | "chime";
}

/** Resolved lazily via the shared dataDir() (VIDI_DATA_DIR override, else
 *  <cwd>/data) so tests chdir a temp dir and a fresh install points at the temp
 *  dir. Unset → byte-identical to <cwd>/data/events/spoken-ledger.jsonl. */
function ledgerPath(): string {
  return dataPath("events", "spoken-ledger.jsonl");
}

function appendEntry(entry: LedgerEntry): void {
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch {
    // Fail-open: a ledger write must never throw into a voice turn. Losing a
    // budget increment at worst lets one extra speech through — acceptable.
  }
}

export function recordSpoken(ts: number): void {
  appendEntry({ ts, kind: "speak" });
}

export function recordChime(ts: number): void {
  appendEntry({ ts, kind: "chime" });
}

/** Same local calendar day (year/month/date), so budgets reset at midnight. */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function todaysCounts(now: Date): {
  spokenTodayCount: number;
  chimeTodayCount: number;
  lastSpokenAtMs: number | null;
} {
  const empty = { spokenTodayCount: 0, chimeTodayCount: 0, lastSpokenAtMs: null };
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    // Missing ledger on a fresh day is the normal case, not an error.
    return empty;
  }

  let spokenTodayCount = 0;
  let chimeTodayCount = 0;
  let lastSpokenAtMs: number | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // Skip a corrupt line rather than losing the whole ledger.
      continue;
    }
    if (typeof entry.ts !== "number") continue;
    if (!isSameLocalDay(new Date(entry.ts), now)) continue;

    if (entry.kind === "speak") {
      spokenTodayCount++;
      if (lastSpokenAtMs === null || entry.ts > lastSpokenAtMs) {
        lastSpokenAtMs = entry.ts;
      }
    } else if (entry.kind === "chime") {
      chimeTodayCount++;
    }
  }

  return { spokenTodayCount, chimeTodayCount, lastSpokenAtMs };
}
