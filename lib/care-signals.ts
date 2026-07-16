import type { ChatMessage } from "./store.ts";

/**
 * Care signals — a compact, NEUTRAL read of the shape of the current sitting.
 *
 * Vidi's persona ("How you care") asks her to watch the time and what the user
 * is doing and, RARELY, respond like someone who cares — without hardcoded
 * "if hour>23 then say X" triggers, which produce exactly the too-obvious,
 * naggy behavior we're avoiding. So this module does NOT decide anything and
 * NEVER emits phrasing. It surfaces raw observations as data; the model's
 * judgment plus the persona principles decide IF and HOW to react, with
 * restraint.
 *
 * Everything Vidi already gets elsewhere — calendar, open commitments,
 * on-screen context, the 48h buffer, the wall clock — is left to preamble.ts /
 * recent.ts / voice-turn.ts. This adds only what was missing: local-hour
 * lateness, how long this continuous sitting has run, whether the user just
 * returned after a gap, and whether the same thing has been retried back to
 * back (a "stuck" tell).
 *
 * Pure and I/O-free: takes the voice thread's messages + `now` and returns
 * plain numbers/booleans. Trivially unit-testable, ~free, and it cannot drift
 * the persona because it produces no prose beyond one clearly-labeled block.
 */

/** A continuous sitting is broken by a gap this long between turns. Matches the
 *  voice route's PREAMBLE_FRESH_AFTER_MS so "this sitting" means the same window
 *  the preamble uses to decide a conversation is fresh. */
export const SESSION_GAP_MS = 45 * 60 * 1000;

/** Hours counted as the small hours for the neutral `isLate` flag. Late night
 *  through pre-dawn. This is a FLAG, not a command — the model decides whether
 *  it's worth a word, and usually it isn't. */
const LATE_START_HOUR = 23; // 11pm
const LATE_END_HOUR = 5; // through 4:59am

/** How far back to look for a repeated ask, and how much lexical overlap counts
 *  as "the same thing again". Kept deliberately loose — this is a soft tell, not
 *  a classifier. */
const RETRY_LOOKBACK_TURNS = 6;
const RETRY_OVERLAP_RATIO = 0.6;
const RETRY_MIN_WORDS = 3;

export interface CareSignals {
  /** Wall-clock hour (0-23) in the user's local time. */
  localHour: number;
  /** True in the small hours (23:00–04:59). A neutral flag, not a nudge. */
  isLate: boolean;
  /** Minutes this continuous sitting has run (0 for a first/lone turn). */
  minutesInSession: number;
  /** True when this turn is the first one back after a long quiet gap. */
  returningAfterGap: boolean;
  /** How many of the recent user turns restate the same ask back-to-back
   *  (1 = no repeat; 3 = the current ask plus two near-identical ones before). */
  recentRetryCount: number;
}

export interface CareSignalsOptions {
  now?: Date;
  /** The just-arrived user transcript (not yet appended to the thread), used to
   *  detect a retry against the prior user turns. */
  currentUserText?: string;
}

/**
 * Compute the neutral session-shape signals from the voice thread's message
 * history. `messages` is the thread as it stands BEFORE the current turn is
 * appended; pass the incoming transcript as `currentUserText` so a retry is
 * counted including the turn in flight.
 */
export function computeCareSignals(
  messages: ChatMessage[],
  options: CareSignalsOptions = {}
): CareSignals {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const localHour = now.getHours();
  const isLate = localHour >= LATE_START_HOUR || localHour < LATE_END_HOUR;

  const timestamps = messages.map((m) => m.ts).filter((ts) => typeof ts === "number");
  const lastTs = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;

  // A gap since the last turn means the previous sitting ended; this turn opens
  // a new one. With no prior turns at all it's a first sitting, not a "return".
  const returningAfterGap =
    lastTs !== null && nowMs - lastTs > SESSION_GAP_MS;

  // The current sitting started at the first turn after the most recent gap.
  const sessionStartMs = sittingStartMs(timestamps, nowMs);
  const minutesInSession = sessionStartMs === null
    ? 0
    : Math.max(0, Math.floor((nowMs - sessionStartMs) / 60000));

  const recentRetryCount = countRecentRetries(messages, options.currentUserText);

  return { localHour, isLate, minutesInSession, returningAfterGap, recentRetryCount };
}

/**
 * The start timestamp of the current continuous sitting: walk backwards from the
 * newest turn while each step is within SESSION_GAP_MS of the next, and return
 * the oldest such timestamp. Returns null when there are no prior turns (a lone
 * first turn has zero elapsed sitting time).
 */
function sittingStartMs(timestamps: number[], nowMs: number): number | null {
  if (timestamps.length === 0) return null;
  // If the newest prior turn is itself beyond the gap, this turn starts a fresh
  // sitting → zero elapsed so far.
  const newest = timestamps[timestamps.length - 1];
  if (nowMs - newest > SESSION_GAP_MS) return null;

  let start = newest;
  for (let i = timestamps.length - 2; i >= 0; i--) {
    if (start - timestamps[i] > SESSION_GAP_MS) break;
    start = timestamps[i];
  }
  return start;
}

/** Lowercased word set of length ≥ RETRY_MIN_WORDS-agnostic tokens. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  );
}

/** Jaccard-ish overlap: shared words / smaller set. Robust to length. */
function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * How many of the most recent user turns (including the one in flight) restate
 * the same ask. 1 means "no repeat" — a normal fresh ask. It climbs only when
 * consecutive user turns are lexically near-identical, the "I keep asking the
 * same thing / keep hitting the same wall" tell. Purely lexical: no LLM, no
 * assumptions about intent — the model reads the number and decides if it means
 * anything.
 */
function countRecentRetries(
  messages: ChatMessage[],
  currentUserText?: string
): number {
  const userTexts: string[] = [];
  if (currentUserText && currentUserText.trim()) userTexts.push(currentUserText);
  for (let i = messages.length - 1; i >= 0 && userTexts.length < RETRY_LOOKBACK_TURNS; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.text === "string" && m.text.trim()) {
      userTexts.push(m.text);
    }
  }
  if (userTexts.length === 0) return 0;

  // Walk from the newest (index 0) while each successive pair stays similar.
  const sets = userTexts.map(wordSet);
  let count = 1;
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].size < RETRY_MIN_WORDS && sets[i - 1].size < RETRY_MIN_WORDS) break;
    if (overlapRatio(sets[i - 1], sets[i]) >= RETRY_OVERLAP_RATIO) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Render the signals as ONE compact, explicitly-hedged prompt block, or null
 * when nothing is worth surfacing (the common case: daytime, short session, no
 * repeats, no return). The label does the load-bearing work: it tells the model
 * these are observations for its judgment, to act on rarely. No phrasing, no
 * "you should" — just the neutral facts and the restraint instruction.
 */
export function renderCareSignals(signals: CareSignals): string | null {
  const notes: string[] = [];
  if (signals.isLate) notes.push(`local time is ${formatHour(signals.localHour)} (late)`);
  if (signals.minutesInSession >= 90) {
    notes.push(`this sitting has run ~${Math.round(signals.minutesInSession / 15) * 15} min`);
  }
  if (signals.returningAfterGap) notes.push(`he's just back after a quiet gap`);
  if (signals.recentRetryCount >= 3) {
    notes.push(`the same ask has come up ${signals.recentRetryCount}× in a row`);
  }
  if (notes.length === 0) return null;

  return (
    `SESSION SIGNALS (neutral observations for your judgment — act on them ` +
    `RARELY and only when it genuinely serves him; usually the right move is ` +
    `to notice and say nothing): ` +
    notes.join("; ") +
    `.`
  );
}

function formatHour(hour24: number): string {
  const period = hour24 < 12 ? "am" : "pm";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12}${period}`;
}
