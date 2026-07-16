import fs from "node:fs";
import path from "node:path";

import { dataPath } from "./data-dir.ts";
import { dueCommitments, openCommitments, somedayCommitments } from "./commitments.ts";
import { workspacePath } from "./workspace.ts";
import { getUserConfig } from "./user-config.ts";

/**
 * B3 anticipation — the deterministic, zero-LLM proactive moments the broker
 * layers on top of the ordinary event spool:
 *
 *   • the MORNING GREETING, delivered once on the first presence.wake of the day
 *     (composed from what's waiting + commitments due + whether a morning brief
 *     landed), and
 *   • the EVENING WRAP, delivered once after 18:00 when the room is quiet and
 *     the owner is actually there.
 *
 * The composition here is pure string-building from cheap disk reads: no model,
 * no cost, no network. lib/events.ts owns the *when* (the broker bypass for the
 * greeting, the 30s-tick trigger for the wrap); this file owns the *what* (the
 * ledgers that keep each to once-per-day, and the phrasing).
 *
 * Every read is fail-open, mirroring the rest of the spine: a missing/garbled
 * ledger or queue degrades to "nothing to say", never an exception into the
 * broker loop.
 */

/* -------------------------------------------------------------------------- */
/* Paths (cwd-based data/, so tests chdir a temp dir)                         */
/* -------------------------------------------------------------------------- */

/** Today's ops briefings live here; a file named for today = "brief landed". */
const BRIEFINGS_DIR = workspacePath(getUserConfig().brainDirName, "BRIEFINGS");

/** The senses calendar page the T-10 pre-brief producer also parses. */
const CALENDAR_FILE = workspacePath(getUserConfig().brainDirName, "senses", "calendar-upcoming.md");

/** The senses file records only a start; assume an hour if nothing says otherwise. */
const DEFAULT_MEETING_MS = 60 * 60 * 1000;

/**
 * Escalation grace window: how long a chimed-but-unspoken anticipation event
 * (morning greeting / evening wrap) waits for the room to become receptive
 * before it terminates in a phone push instead of dying as a silent queue.
 */
export const ANTICIPATION_ESCALATION_GRACE_MS = 25 * 60 * 1000;

/**
 * Re-chime cadence for a non-receptive evening wrap. The wrap rides the broker's
 * 30s tick, but chiming every 30s for the whole grace window is a nag — tonight
 * (2026-07-07) it fired every 30s for 70+ minutes. Once the wrap is pending, it
 * re-chimes at most once per this interval until it either speaks (room became
 * receptive) or escalates to a phone push. 12 minutes keeps a couple of gentle
 * re-nudges inside the 25-minute grace window without turning into a metronome.
 */
export const WRAP_RECHIME_INTERVAL_MS = 12 * 60 * 1000;

/**
 * "Recently at the desk" bound for the wrap's receptiveness gate: idle up to
 * this long still counts as receptive (screen-saver-adjacent idle, not
 * away-from-desk idle). 10 minutes is long enough to cover the ordinary lulls
 * of reading/thinking at the desk without input, short enough that genuinely
 * stepping away (dinner, a walk) still falls through to the escalation push
 * instead of getting spoken into an empty room.
 */
export const WRAP_RECEPTIVE_IDLE_MAX_SECONDS = 10 * 60;

/**
 * Greeting catch-up cutoff (local hour). If no presence.wake has arrived by
 * this hour, the greeting is delivered as a compact phone push so the day is
 * never zero-delivery. Before the cutoff, a late wake still speaks it normally.
 */
export const GREETING_CATCHUP_CUTOFF_HOUR = 12;

function eventsDataDir(): string {
  // Shared dataDir() (VIDI_DATA_DIR override, else <cwd>/data) — unset resolves
  // byte-identically to <cwd>/data/events.
  return dataPath("events");
}
function greetingLedgerPath(): string {
  return path.join(eventsDataDir(), "greeting-ledger.json");
}
function eveningWrapLedgerPath(): string {
  return path.join(eventsDataDir(), "evening-wrap-ledger.json");
}
function queuedPath(): string {
  return path.join(eventsDataDir(), "queued.jsonl");
}
/** Written by lib/policy.ts; we only READ it (never modify policy.ts). */
function spokenLedgerPath(): string {
  return path.join(eventsDataDir(), "spoken-ledger.jsonl");
}
/**
 * Append-only per-day history of every TERMINAL anticipation delivery (both
 * kinds: greeting + evening wrap). The per-event ledgers above only ever hold
 * the LATEST day's state — a single-slot overwrite — so "was yesterday
 * delivered" becomes unanswerable the moment today's greeting/wrap stamps.
 * This log is the fix: one JSON line per terminal stamp, so a same-goal
 * verifyCmd (bin/check-anticipation-delivery.mjs) can always look up any past
 * day, not just whichever day happens to still be sitting in the ledger.
 * Tiny (2 lines/day) — no rotation needed.
 */
function anticipationHistoryPath(): string {
  return path.join(eventsDataDir(), "anticipation-history.jsonl");
}
function appendAnticipationHistory(kind: "greeting" | "wrap", date: string, via: DeliveryChannel): void {
  try {
    fs.mkdirSync(eventsDataDir(), { recursive: true });
    fs.appendFileSync(
      anticipationHistoryPath(),
      JSON.stringify({ date, kind, via, ts: Date.now() }) + "\n"
    );
  } catch {
    // Fail-open: losing a history line degrades the delivery-health check's
    // precision (it falls back to the ledger heuristic), never breaks delivery.
  }
}

/* -------------------------------------------------------------------------- */
/* Per-date ledgers — "did we already do this today?"                         */
/* -------------------------------------------------------------------------- */

/** Local calendar day key (YYYY-MM-DD), so "today" flips at local midnight and
 *  matches the local-day budgets in lib/policy.ts. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * How an anticipation event ultimately terminated. This is what makes "queued"
 * stop being a silent terminal state: a chime/queue that hasn't SPOKEN yet is
 * recorded as "pending" (escalation still owed), and only "spoken"/"push"/
 * "quiet-suppressed" are truly terminal. The escalator on the broker tick reads
 * this to decide whether an owed delivery still needs a phone push.
 */
export type DeliveryChannel = "spoken" | "push" | "pending" | "quiet-suppressed";

export interface DateLedgerState {
  date: string;
  /** Terminal channel, or "pending" while an escalation is still owed. */
  via: DeliveryChannel;
  /** Epoch ms the first non-spoken attempt (chime+queue) landed — the clock the
   *  escalation grace window counts from. Anchored at the FIRST pending attempt
   *  and never moved by later re-queues. Only meaningful while via==="pending". */
  pendingSinceMs?: number;
  /** Epoch ms of the most recent chime for a pending wrap — the cadence clock
   *  that keeps a non-receptive room to at most one chime per
   *  WRAP_RECHIME_INTERVAL_MS instead of one per 30s broker tick. Only
   *  meaningful while via==="pending". */
  lastChimeMs?: number;
}

function readDateLedger(file: string): DateLedgerState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.date !== "string") return null;
    const via: DeliveryChannel =
      parsed.via === "spoken" ||
      parsed.via === "push" ||
      parsed.via === "pending" ||
      parsed.via === "quiet-suppressed"
        ? parsed.via
        : // Legacy ledgers (pre-escalation) recorded only { date }; a stamped
          // date with no channel meant "delivered", so treat it as terminal.
          "spoken";
    return {
      date: parsed.date,
      via,
      pendingSinceMs:
        typeof parsed.pendingSinceMs === "number" ? parsed.pendingSinceMs : undefined,
      lastChimeMs:
        typeof parsed.lastChimeMs === "number" ? parsed.lastChimeMs : undefined,
    };
  } catch {
    // Missing ledger on a fresh day is the normal case, not an error.
    return null;
  }
}

function writeDateLedger(file: string, state: DateLedgerState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // temp+rename so a reader never sees a torn file.
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch {
    // Fail-open: losing the ledger at worst re-delivers once — never throw.
  }
}

/** The raw ledger state for today, or null if nothing's been stamped today. */
export function greetingLedgerToday(now: Date): DateLedgerState | null {
  const s = readDateLedger(greetingLedgerPath());
  return s && s.date === localDateKey(now) ? s : null;
}
export function eveningWrapLedgerToday(now: Date): DateLedgerState | null {
  const s = readDateLedger(eveningWrapLedgerPath());
  return s && s.date === localDateKey(now) ? s : null;
}

/** A greeting counts as "delivered" (no further action owed) only once it has
 *  terminated — spoken, pushed, or quiet-suppressed. A "pending" stamp is NOT
 *  delivered: an escalation is still owed. */
export function greetingDeliveredToday(now: Date): boolean {
  const s = greetingLedgerToday(now);
  return s !== null && s.via !== "pending";
}
export function recordGreeting(now: Date, via: DeliveryChannel = "spoken"): void {
  const date = localDateKey(now);
  writeDateLedger(greetingLedgerPath(), { date, via });
  // Every call site passes a terminal channel (default "spoken", or explicit
  // "quiet-suppressed"/"push") — recordGreeting has no "pending" state, unlike
  // the wrap, so every stamp here is history-worthy.
  appendAnticipationHistory("greeting", date, via);
}

export function eveningWrapDeliveredToday(now: Date): boolean {
  const s = eveningWrapLedgerToday(now);
  return s !== null && s.via !== "pending";
}
export function recordEveningWrap(now: Date, via: DeliveryChannel = "spoken"): void {
  const date = localDateKey(now);
  writeDateLedger(eveningWrapLedgerPath(), { date, via });
  // recordEveningWrap is only ever called with a terminal channel (spoken
  // default, or explicit "quiet-suppressed"/"push"); the non-terminal "pending"
  // state goes through recordEveningWrapPending below and is NOT logged here.
  appendAnticipationHistory("wrap", date, via);
}

/**
 * Stamp the evening wrap as chimed+queued but NOT yet spoken. IDEMPOTENT across
 * the broker's repeated 30s ticks: the escalation clock (`pendingSinceMs`) is
 * anchored at the FIRST pending attempt and never moves. A previous bug reset it
 * to `now` on every tick, so `now - pendingSinceMs` never reached the grace
 * window and the phone escalation never fired (the 70-minute 30s-chime incident,
 * 2026-07-07). `chimed:true` advances the re-chime cadence clock (`lastChimeMs`);
 * a bookkeeping re-stamp (`chimed:false`) leaves both clocks untouched.
 * `recordEveningWrap` with a terminal channel overwrites this once the wrap
 * speaks (room became receptive) or escalates to a push. Not a terminal state,
 * so this deliberately does NOT append to the history log — only a genuine
 * delivery (spoken/push/quiet-suppressed) is history-worthy.
 */
export function recordEveningWrapPending(now: Date, chimed: boolean = true): void {
  const existing = eveningWrapLedgerToday(now);
  const anchoredSince =
    existing && existing.via === "pending" && typeof existing.pendingSinceMs === "number"
      ? existing.pendingSinceMs
      : now.getTime();
  const lastChimeMs = chimed ? now.getTime() : existing?.lastChimeMs;
  writeDateLedger(eveningWrapLedgerPath(), {
    date: localDateKey(now),
    via: "pending",
    pendingSinceMs: anchoredSince,
    lastChimeMs,
  });
}

/**
 * Whether the non-receptive evening wrap should chime on THIS broker tick. True
 * on the first pending attempt, then only once WRAP_RECHIME_INTERVAL_MS has
 * elapsed since the last chime — so a non-receptive room hears at most one chime
 * per interval rather than one per 30s tick. Pure read of the ledger clock; the
 * escalation clock is untouched. */
export function shouldChimeEveningWrap(now: Date): boolean {
  const s = eveningWrapLedgerToday(now);
  if (!s || s.via !== "pending") return true;
  if (typeof s.lastChimeMs !== "number") return true;
  return now.getTime() - s.lastChimeMs >= WRAP_RECHIME_INTERVAL_MS;
}

/* -------------------------------------------------------------------------- */
/* Cheap disk reads that feed the phrasing                                    */
/* -------------------------------------------------------------------------- */

/** Titles of everything currently sitting in the queue, oldest-first. */
export function queuedTitles(): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(queuedPath(), "utf8");
  } catch {
    return [];
  }
  const titles: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e.title === "string" && e.title.trim()) {
        titles.push(e.title.trim());
      }
    } catch {
      // Skip a corrupt queue line rather than losing the greeting.
    }
  }
  return titles;
}

/** True if an ops briefing file named for today exists (the morning brief). */
export function hasMorningBrief(now: Date, dir: string = BRIEFINGS_DIR): boolean {
  try {
    const key = localDateKey(now);
    return fs.readdirSync(dir).some((f) => f.endsWith(".md") && f.includes(key));
  } catch {
    return false;
  }
}

/**
 * Whether a calendar event is spanning `now`. The senses page records only a
 * start (`- **<iso>** — <summary>`), so "spanning now" means an event that
 * started at/before now with the default meeting window still open. All-day /
 * date-only rows never count (they have no minute-precise span). Fail-open to
 * false — a missing/garbled calendar only ever makes the broker LOUDER, and the
 * daily budget still caps the blast radius.
 */
export function isInMeeting(
  now: Date,
  calendarPath: string = CALENDAR_FILE,
  defaultDurationMs: number = DEFAULT_MEETING_MS
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(calendarPath, "utf8");
  } catch {
    return false;
  }
  const nowMs = now.getTime();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("- **")) continue;
    // Mirror the producer exactly: strip "- **", split on "** — ".
    const rest = t.slice(4);
    const idx = rest.indexOf("** — ");
    if (idx === -1) continue;
    const whenRaw = rest.slice(0, idx).trim();
    if (!whenRaw.includes("T")) continue; // date-only / all-day: no minute span
    const startMs = Date.parse(whenRaw);
    if (Number.isNaN(startMs)) continue;
    if (startMs <= nowMs && nowMs < startMs + defaultDurationMs) return true;
  }
  return false;
}

/**
 * Whether NO unprompted speech has been recorded on/after `sinceMs`. Reads the
 * policy spoken-ledger. Fail-open to true (assume the room's been quiet) so an
 * unreadable ledger doesn't suppress the wrap — better a wrap than silence.
 */
export function noUnpromptedSpeechSince(sinceMs: number): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(spokenLedgerPath(), "utf8");
  } catch {
    return true;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && e.kind === "speak" && typeof e.ts === "number" && e.ts >= sinceMs) {
        return false;
      }
    } catch {
      // A corrupt line can't prove speech happened; keep scanning.
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Morning greeting                                                           */
/* -------------------------------------------------------------------------- */

export interface GreetingParts {
  /** How many events are waiting in the queue. */
  waitingCount: number;
  /** The first few queued titles, for the spoken teaser. */
  topTitles: string[];
  /** Commitments whose due date has arrived. */
  dueCount: number;
  /** A morning brief file landed for today. */
  hasMorningBrief: boolean;
}

export function gatherGreeting(now: Date): GreetingParts {
  const titles = queuedTitles();
  return {
    waitingCount: titles.length,
    topTitles: titles.slice(0, 3),
    dueCount: dueCommitments(now).length,
    hasMorningBrief: hasMorningBrief(now),
  };
}

/** Pure phrasing so tests pin the exact template without touching disk. */
export function composeGreeting(p: GreetingParts): string {
  const bits: string[] = ["Morning."];
  if (p.waitingCount > 0) {
    const teaser = p.topTitles.length ? ` — ${p.topTitles.join(", ")}` : "";
    bits.push(`${p.waitingCount} waiting${teaser}.`);
  }
  if (p.dueCount > 0) {
    bits.push(`${p.dueCount} commitment${p.dueCount === 1 ? "" : "s"} due today.`);
  }
  if (p.hasMorningBrief) {
    bits.push("Your morning brief is ready.");
  }
  if (bits.length === 1) bits.push("Nothing waiting — clear morning.");
  return bits.join(" ");
}

export function buildGreeting(now: Date): string {
  return composeGreeting(gatherGreeting(now));
}

/** Compact, notification-shaped variant of the greeting for the missed-window
 *  phone push (no "Morning." salutation padding; just the substance). Pure. */
export function composeCompactGreeting(p: GreetingParts): string {
  const bits: string[] = [];
  if (p.waitingCount > 0) {
    const teaser = p.topTitles.length ? ` (${p.topTitles.join(", ")})` : "";
    bits.push(`${p.waitingCount} waiting${teaser}`);
  }
  if (p.dueCount > 0) {
    bits.push(`${p.dueCount} due today`);
  }
  if (p.hasMorningBrief) bits.push("morning brief ready");
  return bits.length ? bits.join(" · ") : "Nothing waiting — clear morning.";
}

export function buildCompactGreeting(now: Date): string {
  return composeCompactGreeting(gatherGreeting(now));
}

/* -------------------------------------------------------------------------- */
/* Evening wrap                                                               */
/* -------------------------------------------------------------------------- */

export interface WrapParts {
  /** Commitment texts, due-first then other open, for the spoken recap. */
  commitmentTexts: string[];
  /** Titles still sitting in the queue. */
  queuedTitles: string[];
  /** Open commitments with no parseable due — the "someday" bucket count, so an
   *  undatable promise is acknowledged in the wrap instead of silently lost. */
  somedayCount: number;
}

export function gatherEveningWrap(now: Date): WrapParts {
  const due = dueCommitments(now);
  const dueIds = new Set(due.map((c) => c.id));
  const open = openCommitments().filter((c) => !dueIds.has(c.id));
  // Someday items are a subset of `open` (undated). They still show up in the
  // commitmentTexts recap above; the count also gets an explicit mention so
  // even beyond the top-3 recap, none go unacknowledged.
  return {
    commitmentTexts: [...due, ...open].map((c) => c.text),
    queuedTitles: queuedTitles(),
    somedayCount: somedayCommitments(now).length,
  };
}

/** Pure phrasing, symmetrical with composeGreeting. */
export function composeEveningWrap(p: WrapParts): string {
  const bits: string[] = ["Evening wrap."];
  if (p.commitmentTexts.length) {
    bits.push(`Still open: ${p.commitmentTexts.slice(0, 3).join("; ")}.`);
  }
  if (p.queuedTitles.length) {
    const teaser = p.queuedTitles.slice(0, 3).join(", ");
    bits.push(`${p.queuedTitles.length} waiting — ${teaser}.`);
  }
  if (p.somedayCount > 0) {
    bits.push(
      `And ${p.somedayCount} open ${p.somedayCount === 1 ? "item" : "items"} with no date.`
    );
  }
  if (bits.length === 1) bits.push("Nothing open — you're clear.");
  return bits.join(" ");
}

export function buildEveningWrap(now: Date): string {
  return composeEveningWrap(gatherEveningWrap(now));
}
