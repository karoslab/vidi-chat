#!/usr/bin/env node
/**
 * check-anticipation-delivery — the deterministic verifyCmd for the
 * `proactive-delivery-health` standing goal.
 *
 * Exit 0 iff YESTERDAY's morning greeting AND evening wrap both terminated in a
 * real delivery. A "delivery" is a terminal DeliveryChannel: `spoken`, `push`,
 * or `quiet-suppressed` (a deliberately silent day still counts — the wrap that
 * was intentionally held is delivered-as-silence, not a failure). A `pending`
 * stamp (escalation still owed) or no record at all does NOT count — that is
 * exactly the "a day went silent" case the goal exists to catch. Exit 1 then,
 * so the standing-goal loop diagnoses why and files a finding.
 *
 * PRIMARY SOURCE: data/events/anticipation-history.jsonl — an append-only log
 * (lib/anticipation.ts, appendAnticipationHistory) with one line per TERMINAL
 * stamp: {date, kind: "greeting"|"wrap", via, ts}. This is the only source that
 * can answer "was yesterday delivered" correctly on every day, including a
 * morning where today's own greeting has already fired before this check runs.
 *
 * FALLBACK (fresh installs / pre-history data only): if
 * anticipation-history.jsonl doesn't exist yet, fall back to reading the two
 * per-event ledger files (greeting-ledger.json / evening-wrap-ledger.json),
 * which hold only the MOST RECENT day's terminal state — a single-slot
 * overwrite. This fallback is a HEURISTIC, not a fact: once today's own
 * greeting/wrap has stamped, yesterday's ledger entry is gone, and the
 * fallback then correctly reports "can't tell" rather than silently guessing
 * pass or fail either way (see the explicit "heuristic can't tell" reasons
 * below) — logged loudly as FALLBACK HEURISTIC so it's never mistaken for a
 * real verdict. It self-heals: once lib/anticipation.ts has stamped once
 * post-upgrade, the history file exists and this fallback never fires again.
 *
 * Dependency-free .mjs so it runs as a plain `node bin/check-anticipation-delivery.mjs`
 * verifyCmd (same convention as bin/vidictl.mjs). Reads VIDI_DATA_DIR if set,
 * else <repo>/data — matching lib/data-dir.ts. VIDI_NOW_MS optionally pins "now"
 * (epoch ms) for clock-pinned tests; unset → real Date.now(), unchanged for prod.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dataDir() {
  const override = process.env.VIDI_DATA_DIR;
  if (typeof override === "string" && override.trim()) return override.trim();
  return path.join(REPO, "data");
}

/** Local calendar day key (YYYY-MM-DD) — byte-identical to lib/anticipation.ts. */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DELIVERED = new Set(["spoken", "push", "quiet-suppressed"]);

/* -------------------------------------------------------------------------- */
/* Primary: append-only history                                              */
/* -------------------------------------------------------------------------- */

/** Parse anticipation-history.jsonl, tolerating a corrupt/partial trailing
 *  line (append can race a crash) — skip bad lines rather than fail the check.
 *  Returns null when the file itself is absent (→ caller falls back). */
function readHistoryLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev && typeof ev.date === "string" && typeof ev.kind === "string") lines.push(ev);
    } catch {
      // corrupt line — skip, don't fail the whole read
    }
  }
  return lines;
}

/** Did `kind` terminate delivered on `targetKey`, per the history log? */
function historyDeliveredFor(lines, kind, targetKey) {
  const matches = lines.filter((ev) => ev.kind === kind && ev.date === targetKey);
  if (!matches.length) {
    return { ok: false, reason: `no ${kind} history entry for ${targetKey} — that day went unstamped` };
  }
  // A terminal kind stamps once per day; take the LAST match defensively.
  const via = matches[matches.length - 1].via;
  if (!DELIVERED.has(via)) {
    return { ok: false, reason: `${targetKey} ${kind} terminated as "${via}", not a delivered channel` };
  }
  return { ok: true, reason: `delivered via ${via} (history, ${targetKey})` };
}

/* -------------------------------------------------------------------------- */
/* Fallback: latest-day ledger heuristic (pre-history / fresh installs only)  */
/* -------------------------------------------------------------------------- */

/**
 * Read one per-event ledger and report whether it shows a delivered terminal
 * state for `targetKey` (yesterday). HEURISTIC ONLY — the ledger holds just the
 * latest day, so this can only speak for `targetKey` when the ledger's stamped
 * date IS `targetKey`. A ledger older than that means the day was genuinely
 * unstamped (real silence). A ledger NEWER than that (today has already
 * stamped) means yesterday's entry was overwritten and unrecoverable — that is
 * reported as its own honest "can't tell" failure reason, not guessed either
 * way, so this fallback never claims a fact it doesn't have.
 */
function ledgerDeliveredFor(file, targetKey) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "ledger missing or unreadable" };
  }
  if (!parsed || typeof parsed.date !== "string") {
    return { ok: false, reason: "ledger has no date" };
  }
  if (parsed.date < targetKey) {
    return { ok: false, reason: `ledger's newest day is ${parsed.date}, older than ${targetKey} — that day went unstamped` };
  }
  if (parsed.date > targetKey) {
    return {
      ok: false,
      reason: `heuristic can't tell: ledger has already moved on to ${parsed.date}, so ${targetKey}'s entry was overwritten before this check ran (this is the known fallback gap — fixed once anticipation-history.jsonl has entries)`,
    };
  }
  const via = typeof parsed.via === "string" ? parsed.via : "spoken";
  if (!DELIVERED.has(via)) {
    return { ok: false, reason: `${parsed.date} terminated as "${via}", not a delivered channel` };
  }
  return { ok: true, reason: `delivered via ${via} (ledger fallback, ${parsed.date})` };
}

function nowMs() {
  const override = process.env.VIDI_NOW_MS;
  if (typeof override === "string" && override.trim() && !Number.isNaN(Number(override))) {
    return Number(override);
  }
  return Date.now();
}

function main() {
  const now = new Date(nowMs());
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const targetKey = localDateKey(yesterday);
  const dir = path.join(dataDir(), "events");

  const historyLines = readHistoryLines(path.join(dir, "anticipation-history.jsonl"));
  const usingFallback = historyLines === null;

  let greeting, wrap;
  if (usingFallback) {
    greeting = ledgerDeliveredFor(path.join(dir, "greeting-ledger.json"), targetKey);
    wrap = ledgerDeliveredFor(path.join(dir, "evening-wrap-ledger.json"), targetKey);
  } else {
    greeting = historyDeliveredFor(historyLines, "greeting", targetKey);
    wrap = historyDeliveredFor(historyLines, "wrap", targetKey);
  }

  const lines = [`proactive-delivery-health — checking ${targetKey} (yesterday):`];
  if (usingFallback) {
    lines.push(
      "  FALLBACK HEURISTIC: anticipation-history.jsonl not found — reading the latest-day ledgers instead. This is imprecise (can't see a day whose ledger slot has already been overwritten by today) and will stop firing once history entries exist."
    );
  }
  lines.push(`  morning greeting: ${greeting.ok ? "OK" : "SILENT"} — ${greeting.reason}`);
  lines.push(`  evening wrap:     ${wrap.ok ? "OK" : "SILENT"} — ${wrap.reason}`);
  const pass = greeting.ok && wrap.ok;
  lines.push(pass ? "  verdict: both delivered" : "  verdict: a day went silent — the goal loop will diagnose + file a fix/finding");
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(pass ? 0 : 1);
}

main();
