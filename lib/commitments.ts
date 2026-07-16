import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * Commitments ledger — the promises Vidi makes out loud ("I'll check tonight",
 * "I'll remind you tomorrow") so they become tracked debts she pays back in the
 * evening wrap and the next preamble, instead of forgotten small-talk.
 *
 * One JSON object per line at data/commitments.jsonl:
 *   { id, ts, text, due?, status: "open"|"done"|"dropped", source? }
 *
 * Every read is fail-open: a corrupt ledger must never throw into a voice turn.
 * A missing file, a bad line, a garbled record — all degrade to "no commitment"
 * rather than crashing the reply. Clarity over brevity; comments say WHY.
 */

export type CommitmentStatus = "open" | "done" | "dropped";

export interface Commitment {
  id: string;
  ts: number;
  text: string;
  due?: string; // free-form: ISO string, or loose "tonight"/"tomorrow"
  status: CommitmentStatus;
  source?: string; // where the promise came from, e.g. "voice", "chat"
}

/** Resolved lazily via the shared dataDir() (VIDI_DATA_DIR override, else
 *  <cwd>/data) so tests chdir a temp dir and a fresh install points at the temp
 *  dir. Unset → byte-identical to <cwd>/data/commitments.jsonl. */
function ledgerPath(): string {
  return dataPath("commitments.jsonl");
}

/** Read every well-formed record; skip corrupt/partial lines silently. */
function readAll(): Commitment[] {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    // Missing ledger is the normal cold-start case, not an error.
    return [];
  }
  const out: Commitment[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // One bad line shouldn't lose the whole ledger — skip it.
      continue;
    }
    if (!isCommitment(record)) continue;
    out.push(record);
  }
  return out;
}

/** A record is usable only if the load-bearing fields are the right shape. */
function isCommitment(value: unknown): value is Commitment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.ts === "number" &&
    typeof v.text === "string" &&
    (v.status === "open" || v.status === "done" || v.status === "dropped")
  );
}

/**
 * Rewrite the whole ledger. We keep the file small (promises are rare) so a
 * full rewrite is cheaper and simpler than in-place line surgery, and it also
 * compacts away any corrupt lines we skipped on read. Fail-open: a failed
 * write must not throw into a voice turn.
 */
function writeAll(records: Commitment[]): void {
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, records.map((r) => JSON.stringify(r) + "\n").join(""));
  } catch {
    // A lost write at worst forgets one promise — never break the reply.
  }
}

/** Short unique-enough id: timestamp + random suffix, no external deps. */
function newId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addCommitment(input: {
  text: string;
  due?: string;
  source?: string;
}): Commitment {
  const commitment: Commitment = {
    id: newId(),
    ts: Date.now(),
    text: input.text.trim(),
    status: "open",
  };
  // Only carry optional fields when present — keeps records clean and small.
  if (input.due && input.due.trim()) commitment.due = input.due.trim();
  if (input.source && input.source.trim()) commitment.source = input.source.trim();

  // Append is the common path; a single append avoids rewriting the whole file
  // on every new promise. Fail-open like everything else here.
  try {
    const p = ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(commitment) + "\n");
  } catch {
    // Even if persistence fails we still hand back the object so the caller's
    // voice turn can proceed as if it stuck.
  }
  return commitment;
}

export function openCommitments(): Commitment[] {
  return readAll().filter((c) => c.status === "open");
}

/** Lowercased word set, punctuation stripped — the unit of fuzzy overlap. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Fuzzy-resolve: mark done the OPEN commitment whose words overlap `text` most.
 * "did you check the logs?" resolves "I'll check the logs tonight". Ties and
 * zero-overlap both return null rather than guessing — better to leave a
 * promise open than to close the wrong one.
 */
export function resolveCommitment(text: string): Commitment | null {
  const records = readAll();
  const target = wordSet(text);
  if (target.size === 0) return null;

  let best: Commitment | null = null;
  let bestScore = 0;
  for (const c of records) {
    if (c.status !== "open") continue;
    const overlap = intersectionSize(wordSet(c.text), target);
    if (overlap > bestScore) {
      bestScore = overlap;
      best = c;
    }
  }
  if (!best || bestScore === 0) return null;

  // Flip status and persist by rewriting (records is the freshest read).
  best.status = "done";
  writeAll(records);
  return best;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n++;
  return n;
}

/**
 * Best-effort parse of a loose due value into an epoch-ms deadline.
 * - "tonight" → 21:00 local on `now`'s day (the "I'll check tonight" default).
 * - "tomorrow" → 21:00 local the next day.
 * - A bare calendar date ("2026-07-11", no time) → END of that day LOCAL
 *   (23:59:59.999).
 * - A naive ISO datetime ("2026-07-11T17:00:00", no zone) → LOCAL wall-clock.
 * - anything unrecognized → null, meaning "never auto-due" (we won't surface a
 *   promise we can't date, so a vague due doesn't nag every single turn).
 *
 * TIMEZONE CONTRACT (must stay in lockstep with the ops event producer,
 * ops/tasks/event_producers.py `_coerce_due_ms` — the two halves consume the
 * SAME model-authored `due` field and MUST agree, or the spoken "due now"
 * reminder fires at a different instant than the evening wrap considers it due):
 *   - naive datetime = LOCAL wall-clock. Native Date.parse already does this for
 *     a datetime carrying no offset, so it needs no special-casing here.
 *   - date-only = END of that LOCAL day. This one DOES need special-casing:
 *     Date.parse treats a date-only ISO string as UTC midnight, which west of
 *     UTC is the PREVIOUS evening (Jul 11 00:00 UTC = Jul 10 19:00 CDT) — the
 *     bug that made "do it tomorrow" go due the night before. A date-only
 *     promise isn't due until its whole local day has passed. A malformed
 *     date ("2026-02-30", "2026-13-45") must return null, matching Python's
 *     `datetime(...)` (which raises ValueError on an out-of-range field) — the
 *     multi-argument Date constructor instead silently ROLLS OVER an
 *     out-of-range month/day into the following month, so we explicitly
 *     reject any rollover after construction (see below).
 *   - an offset-carrying string ("...Z", "...-05:00") keeps its explicit zone.
 *   - the datetime fallback only accepts ISO-shaped strings (YYYY-MM-DD[T
 *     HH:MM[:SS[.ms]][Z|±HH:MM]]) — the same shape Python's
 *     `datetime.fromisoformat` accepts — and returns null on anything else
 *     ("July 11, 2026", "07/11/2026", unpadded "2026-7-11"). Date.parse alone
 *     accepts those non-ISO shapes and reads them as local midnight, which
 *     Python's `fromisoformat` rejects outright (ValueError → None); without
 *     this guard the two halves would disagree on which promises are datable
 *     at all.
 */
function parseDueMs(due: string | undefined, now: Date): number | null {
  if (!due) return null;
  const trimmed = due.trim();
  const lowered = trimmed.toLowerCase();

  if (lowered.includes("tonight")) {
    const d = new Date(now);
    d.setHours(21, 0, 0, 0);
    return d.getTime();
  }
  if (lowered.includes("tomorrow")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(21, 0, 0, 0);
    return d.getTime();
  }

  // A bare calendar date (YYYY-MM-DD, no time component) is due at the END of
  // that day in LOCAL time. We build the Date from the numeric parts — the
  // multi-argument constructor interprets them as local — rather than letting
  // Date.parse read the string, because Date.parse treats a date-only ISO
  // string as UTC midnight (the previous evening west of UTC).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const endOfLocalDay = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      23,
      59,
      59,
      999
    );
    // The multi-argument Date constructor silently ROLLS OVER an out-of-range
    // month/day (e.g. "2026-02-30" becomes Mar 2) instead of rejecting it.
    // Python's datetime(...) raises ValueError on the same input, so we must
    // reject the rollover here too or the two halves diverge: Node would fire
    // a reminder for a date that was never real. Compare the constructed
    // date's fields back against the parsed input and bail to null on any
    // mismatch.
    if (
      endOfLocalDay.getFullYear() !== Number(year) ||
      endOfLocalDay.getMonth() !== Number(month) - 1 ||
      endOfLocalDay.getDate() !== Number(day)
    ) {
      return null;
    }
    return endOfLocalDay.getTime();
  }

  // Fall back to native Date parsing for datetimes and similar — but ONLY for
  // an ISO-shaped string, the same shape Python's `datetime.fromisoformat`
  // accepts. Date.parse alone also accepts non-ISO shapes ("July 11, 2026",
  // "07/11/2026", unpadded "2026-7-11") and reads them as local midnight,
  // which fromisoformat rejects outright (ValueError → None) — without this
  // guard the two halves would disagree on which promises are datable at all.
  // A naive datetime (no offset) is parsed as LOCAL by Date.parse — exactly
  // the contract we want — and an offset-carrying string keeps its zone.
  const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  if (!ISO_DATETIME_RE.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Open commitments that are due by `now`. Undated (unparseable-due) promises
 * are intentionally excluded — see parseDueMs: we only auto-surface something
 * we can actually place on the clock.
 */
export function dueCommitments(now: Date): Commitment[] {
  const cutoff = now.getTime();
  return openCommitments().filter((c) => {
    const dueMs = parseDueMs(c.due, now);
    return dueMs !== null && dueMs <= cutoff;
  });
}

/**
 * Open commitments with NO parseable due date — the "someday" bucket. These are
 * the promises parseDueMs can't place on the clock ("I'll get to it", a garbled
 * due), so dueCommitments deliberately never surfaces them. Without this they're
 * silently lost; the evening wrap uses the count to say "N open items with no
 * date" so an undatable promise is still acknowledged, just not nagged on a
 * schedule. `now` only anchors the parse (relative words like "tonight"); an
 * undatable due is undatable regardless of the anchor.
 */
export function somedayCommitments(now: Date = new Date()): Commitment[] {
  return openCommitments().filter((c) => parseDueMs(c.due, now) === null);
}

/**
 * Retire a commitment by id (status → "dropped"). Returns the updated record,
 * or null if no such id exists. Used when a promise is abandoned rather than
 * fulfilled, so it stops surfacing without pretending it was kept.
 */
export function dropCommitment(id: string): Commitment | null {
  const records = readAll();
  const match = records.find((c) => c.id === id);
  if (!match) return null;
  match.status = "dropped";
  writeAll(records);
  return match;
}
