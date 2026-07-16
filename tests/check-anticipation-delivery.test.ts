import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Exercises bin/check-anticipation-delivery.mjs — the deterministic verifyCmd
// for the proactive-delivery-health goal — as a real subprocess with an
// isolated VIDI_DATA_DIR (never touches a real ledger) and a PINNED clock via
// VIDI_NOW_MS, so "yesterday"/"today" are exact and every case is deterministic.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "bin", "check-anticipation-delivery.mjs");

// A fixed instant: 2026-01-15T12:00:00 local. Yesterday = 2026-01-14, two days
// ago = 2026-01-13, today = 2026-01-15 — all computed the same way the script
// itself computes them (local calendar day), so this stays correct regardless
// of the host's timezone.
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const TODAY = dayKey(new Date(NOW));
const YESTERDAY = dayKey(new Date(NOW - 24 * 60 * 60 * 1000));
const TWO_AGO = dayKey(new Date(NOW - 2 * 24 * 60 * 60 * 1000));

function run(setup: (eventsDir: string) => void): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-delivery-"));
  const events = path.join(dir, "events");
  fs.mkdirSync(events, { recursive: true });
  setup(events);
  try {
    const out = execFileSync("node", [SCRIPT], {
      env: { ...process.env, VIDI_DATA_DIR: dir, VIDI_NOW_MS: String(NOW) },
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

function writeLedger(events: string, name: string, obj: unknown) {
  fs.writeFileSync(path.join(events, name), JSON.stringify(obj));
}
function historyLine(date: string, kind: "greeting" | "wrap", via: string, ts = NOW) {
  return JSON.stringify({ date, kind, via, ts }) + "\n";
}
function writeHistory(events: string, lines: string) {
  fs.writeFileSync(path.join(events, "anticipation-history.jsonl"), lines);
}

// ---------------------------------------------------------------------------
// Primary path: history log (the fix)
// ---------------------------------------------------------------------------

test("history: both terminal yesterday → exit 0", () => {
  const r = run((events) => {
    writeHistory(events, historyLine(YESTERDAY, "greeting", "spoken") + historyLine(YESTERDAY, "wrap", "push"));
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /both delivered/);
  assert.doesNotMatch(r.out, /FALLBACK/);
});

test("history: quiet-suppressed yesterday counts as delivered → exit 0", () => {
  const r = run((events) => {
    writeHistory(
      events,
      historyLine(YESTERDAY, "greeting", "quiet-suppressed") + historyLine(YESTERDAY, "wrap", "quiet-suppressed")
    );
  });
  assert.equal(r.code, 0, r.out);
});

// This is the case the reviewer flagged as MASKED by the old ledger-only logic:
// yesterday was silent (no history), but TODAY's greeting has already stamped.
// The old `date >= yesterday` ledger check would see today's date and
// false-PASS. History fixes this because it looks up yesterday's date
// explicitly rather than trusting whatever the single ledger slot holds today.
test("history: silent yesterday + today's greeting ALREADY stamped → SILENT → exit 1 (the masked case)", () => {
  const r = run((events) => {
    // No entry at all for YESTERDAY — it went silent. Only today's stamped.
    writeHistory(events, historyLine(TODAY, "greeting", "spoken") + historyLine(TODAY, "wrap", "spoken"));
    // Ledgers (irrelevant once history exists) also show today, which is
    // exactly the state that used to false-pass under the old ledger-only check.
    writeLedger(events, "greeting-ledger.json", { date: TODAY, via: "spoken" });
    writeLedger(events, "evening-wrap-ledger.json", { date: TODAY, via: "spoken" });
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /went silent/);
  assert.match(r.out, new RegExp(`no greeting history entry for ${YESTERDAY}`));
  assert.match(r.out, new RegExp(`no wrap history entry for ${YESTERDAY}`));
});

test("history: pending (un-escalated) wrap yesterday → SILENT → exit 1", () => {
  const r = run((events) => {
    writeHistory(events, historyLine(YESTERDAY, "greeting", "spoken"));
    // "pending" never gets written to history (recordEveningWrapPending doesn't
    // log it) — simulate the day genuinely having no terminal wrap entry.
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`no wrap history entry for ${YESTERDAY}`));
});

test("history: entry older than yesterday (day unstamped) → exit 1", () => {
  const r = run((events) => {
    writeHistory(events, historyLine(TWO_AGO, "greeting", "spoken") + historyLine(TWO_AGO, "wrap", "spoken"));
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /went silent/);
});

test("history: one delivered, one silent → exit 1", () => {
  const r = run((events) => {
    writeHistory(events, historyLine(YESTERDAY, "greeting", "spoken"));
    // no wrap entry for yesterday at all
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /morning greeting: OK/);
  assert.match(r.out, /evening wrap:     SILENT/);
});

// ---------------------------------------------------------------------------
// Fallback: no history file yet (fresh install / pre-upgrade data)
// ---------------------------------------------------------------------------

test("fallback: no history file, ledger shows yesterday delivered → exit 0, heuristic logged", () => {
  const r = run((events) => {
    writeLedger(events, "greeting-ledger.json", { date: YESTERDAY, via: "spoken" });
    writeLedger(events, "evening-wrap-ledger.json", { date: YESTERDAY, via: "push" });
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FALLBACK HEURISTIC/);
});

test("fallback: no history file, ledger already moved on to today → honest 'can't tell' failure, NOT a false pass", () => {
  const r = run((events) => {
    writeLedger(events, "greeting-ledger.json", { date: TODAY, via: "spoken" });
    writeLedger(events, "evening-wrap-ledger.json", { date: TODAY, via: "spoken" });
  });
  // The old behavior here was a false PASS (date >= yesterday). The fixed
  // fallback must not claim yesterday was fine when it genuinely can't tell.
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FALLBACK HEURISTIC/);
  assert.match(r.out, /heuristic can't tell/);
});

test("fallback: no history file, ledger older than yesterday → SILENT → exit 1", () => {
  const r = run((events) => {
    writeLedger(events, "greeting-ledger.json", { date: TWO_AGO, via: "spoken" });
    writeLedger(events, "evening-wrap-ledger.json", { date: TWO_AGO, via: "spoken" });
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FALLBACK HEURISTIC/);
  assert.match(r.out, /older than/);
});

test("fallback: no history file, nothing on disk at all → exit 1", () => {
  const r = run(() => {
    /* write nothing */
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FALLBACK HEURISTIC/);
  assert.match(r.out, /missing|unreadable/);
});
