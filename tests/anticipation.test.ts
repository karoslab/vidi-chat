import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the cwd-based data/ dir (the per-date ledgers + queue) before the
// module resolves any cwd paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-anticipation-test-")));

const {
  localDateKey,
  composeGreeting,
  composeEveningWrap,
  greetingDeliveredToday,
  recordGreeting,
  eveningWrapDeliveredToday,
  recordEveningWrap,
  isInMeeting,
  noUnpromptedSpeechSince,
  queuedTitles,
  hasMorningBrief,
} = await import("../lib/anticipation.ts");

/* -------------------------------------------------------------------------- */
/* Pure phrasing                                                              */
/* -------------------------------------------------------------------------- */

test("composeGreeting: full house — waiting + due + brief", () => {
  const g = composeGreeting({
    waitingCount: 3,
    topTitles: ["Release gate held myapp", "VIP email from Alex"],
    dueCount: 2,
    hasMorningBrief: true,
  });
  assert.match(g, /^Morning\./);
  assert.match(g, /3 waiting — Release gate held myapp, VIP email from Alex\./);
  assert.match(g, /2 commitments due today\./);
  assert.match(g, /Your morning brief is ready\./);
});

test("composeGreeting: singular commitment phrasing", () => {
  const g = composeGreeting({ waitingCount: 0, topTitles: [], dueCount: 1, hasMorningBrief: false });
  assert.match(g, /1 commitment due today\./);
  assert.doesNotMatch(g, /commitments/);
});

test("composeGreeting: nothing at all → clear morning", () => {
  const g = composeGreeting({ waitingCount: 0, topTitles: [], dueCount: 0, hasMorningBrief: false });
  assert.equal(g, "Morning. Nothing waiting — clear morning.");
});

test("composeEveningWrap: commitments + queue", () => {
  const w = composeEveningWrap({
    commitmentTexts: ["check the logs", "reply to Sam", "renew the cert", "extra"],
    queuedTitles: ["NightShift finished", "Release gate flip"],
    somedayCount: 0,
  });
  assert.match(w, /^Evening wrap\./);
  // Only the first three commitments are spoken.
  assert.match(w, /Still open: check the logs; reply to Sam; renew the cert\./);
  assert.doesNotMatch(w, /extra/);
  assert.match(w, /2 waiting — NightShift finished, Release gate flip\./);
  // No undated items → no "with no date" mention.
  assert.doesNotMatch(w, /no date/);
});

test("composeEveningWrap: nothing open → clear", () => {
  const w = composeEveningWrap({ commitmentTexts: [], queuedTitles: [], somedayCount: 0 });
  assert.equal(w, "Evening wrap. Nothing open — you're clear.");
});

test("composeEveningWrap: someday bucket count is mentioned when nonzero", () => {
  // Singular.
  const one = composeEveningWrap({ commitmentTexts: [], queuedTitles: [], somedayCount: 1 });
  assert.match(one, /And 1 open item with no date\./);
  // Plural, alongside dated recap.
  const many = composeEveningWrap({
    commitmentTexts: ["ship it"],
    queuedTitles: [],
    somedayCount: 3,
  });
  assert.match(many, /And 3 open items with no date\./);
});

/* -------------------------------------------------------------------------- */
/* Per-date ledgers                                                           */
/* -------------------------------------------------------------------------- */

test("greeting ledger is per-local-day", () => {
  const day1 = new Date(2026, 4, 1, 7, 0, 0);
  const day2 = new Date(2026, 4, 2, 7, 0, 0);
  assert.equal(greetingDeliveredToday(day1), false, "fresh day not yet greeted");
  recordGreeting(day1);
  assert.equal(greetingDeliveredToday(day1), true, "same day now greeted");
  assert.equal(greetingDeliveredToday(day2), false, "next day resets");
});

test("evening wrap ledger is per-local-day and independent of the greeting", () => {
  const day = new Date(2026, 4, 5, 19, 0, 0);
  assert.equal(eveningWrapDeliveredToday(day), false);
  recordEveningWrap(day);
  assert.equal(eveningWrapDeliveredToday(day), true);
  // Recording a wrap must not flip the greeting ledger for that day.
  assert.equal(greetingDeliveredToday(day), false);
});

test("history: recordGreeting appends one terminal line per call", () => {
  const day = new Date(2026, 5, 1, 7, 0, 0);
  recordGreeting(day, "spoken");
  recordGreeting(day, "quiet-suppressed"); // a later stamp same day (e.g. correction)
  const raw = fs.readFileSync(path.join(process.cwd(), "data", "events", "anticipation-history.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const forDay = lines.filter((l) => l.kind === "greeting" && l.date === localDateKey(day));
  assert.equal(forDay.length, 2, "append-only — both stamps recorded, not overwritten");
  assert.equal(forDay[0].via, "spoken");
  assert.equal(forDay[1].via, "quiet-suppressed");
});

test("history: recordEveningWrap appends a terminal line; recordEveningWrapPending does NOT", async () => {
  const { recordEveningWrapPending } = await import("../lib/anticipation.ts");
  const day = new Date(2026, 5, 2, 18, 0, 0);
  recordEveningWrapPending(day); // not terminal — must not appear in history
  recordEveningWrap(day, "push"); // terminal — must appear
  const raw = fs.readFileSync(path.join(process.cwd(), "data", "events", "anticipation-history.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const forDay = lines.filter((l) => l.kind === "wrap" && l.date === localDateKey(day));
  assert.equal(forDay.length, 1, "only the terminal stamp is logged, not the pending one");
  assert.equal(forDay[0].via, "push");
});

test("history: greeting and wrap history lines are independent and both readable", () => {
  const day = new Date(2026, 5, 3, 8, 0, 0);
  recordGreeting(day, "spoken");
  recordEveningWrap(day, "spoken");
  const raw = fs.readFileSync(path.join(process.cwd(), "data", "events", "anticipation-history.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const key = localDateKey(day);
  assert.ok(lines.some((l) => l.kind === "greeting" && l.date === key));
  assert.ok(lines.some((l) => l.kind === "wrap" && l.date === key));
});

test("localDateKey formats YYYY-MM-DD with zero padding", () => {
  assert.equal(localDateKey(new Date(2026, 0, 3, 12, 0, 0)), "2026-01-03");
  assert.equal(localDateKey(new Date(2026, 11, 25, 12, 0, 0)), "2026-12-25");
});

/* -------------------------------------------------------------------------- */
/* isInMeeting — parse of senses/calendar-upcoming.md                        */
/* -------------------------------------------------------------------------- */

function writeCalendar(lines: string[]): string {
  const p = path.join(process.cwd(), `cal-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

test("isInMeeting: event started 10 min ago with default hour window → true", () => {
  const now = new Date(2026, 5, 10, 14, 40, 0);
  const start = new Date(2026, 5, 10, 14, 30, 0);
  const iso = start.toISOString();
  const cal = writeCalendar(["# Calendar", "", `- **${iso}** — Standup @ Zoom (with a@b.com)`]);
  assert.equal(isInMeeting(now, cal), true);
});

test("isInMeeting: event already over (started 2h ago) → false", () => {
  const now = new Date(2026, 5, 10, 16, 40, 0);
  const start = new Date(2026, 5, 10, 14, 30, 0);
  const cal = writeCalendar([`- **${start.toISOString()}** — Standup`]);
  assert.equal(isInMeeting(now, cal), false);
});

test("isInMeeting: future event not yet started → false", () => {
  const now = new Date(2026, 5, 10, 14, 0, 0);
  const start = new Date(2026, 5, 10, 14, 30, 0);
  const cal = writeCalendar([`- **${start.toISOString()}** — Standup`]);
  assert.equal(isInMeeting(now, cal), false);
});

test("isInMeeting: all-day / date-only row is never spanning now", () => {
  const now = new Date(2026, 5, 10, 14, 0, 0);
  const cal = writeCalendar(["- **2026-06-10** — All-day offsite"]);
  assert.equal(isInMeeting(now, cal), false);
});

test("isInMeeting: 'no upcoming events' page → false", () => {
  const cal = writeCalendar(["# Calendar — next 7 days", "", "_No upcoming events in the next 7 days._"]);
  assert.equal(isInMeeting(new Date(), cal), false);
});

test("isInMeeting: missing calendar file → false (fail-open)", () => {
  assert.equal(isInMeeting(new Date(), path.join(process.cwd(), "does-not-exist.md")), false);
});

/* -------------------------------------------------------------------------- */
/* Spoken-ledger quiet check + cheap reads                                    */
/* -------------------------------------------------------------------------- */

test("noUnpromptedSpeechSince: sees a later speak, ignores earlier / chimes", () => {
  const dir = path.join(process.cwd(), "data", "events");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "spoken-ledger.jsonl");
  const cutoff = new Date(2026, 6, 1, 16, 0, 0).getTime();
  fs.writeFileSync(
    p,
    [
      JSON.stringify({ ts: cutoff - 3600_000, kind: "speak" }), // before cutoff
      JSON.stringify({ ts: cutoff + 60_000, kind: "chime" }), // a chime, not speech
    ].join("\n") + "\n"
  );
  assert.equal(noUnpromptedSpeechSince(cutoff), true, "no speak at/after cutoff yet");

  fs.appendFileSync(p, JSON.stringify({ ts: cutoff + 120_000, kind: "speak" }) + "\n");
  assert.equal(noUnpromptedSpeechSince(cutoff), false, "a speak after cutoff breaks the quiet");
});

test("noUnpromptedSpeechSince: missing ledger → true (fail-open to quiet)", () => {
  // A fresh temp cwd with no ledger written for this key.
  const key = new Date(2030, 0, 1, 16, 0, 0).getTime();
  // Remove any ledger the previous test wrote so this reads a clean slate.
  try {
    fs.rmSync(path.join(process.cwd(), "data", "events", "spoken-ledger.jsonl"));
  } catch {
    /* absent is fine */
  }
  assert.equal(noUnpromptedSpeechSince(key), true);
});

test("queuedTitles + hasMorningBrief read cheaply and fail-open on absence", () => {
  // No queue / no briefings dir → empty + false, never throws.
  const dir = path.join(process.cwd(), "data", "events");
  try {
    fs.rmSync(path.join(dir, "queued.jsonl"));
  } catch {
    /* absent is fine */
  }
  assert.deepEqual(queuedTitles(), []);
  assert.equal(hasMorningBrief(new Date(), path.join(process.cwd(), "no-briefings-here")), false);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "queued.jsonl"),
    [JSON.stringify({ title: "one" }), "garbage line", JSON.stringify({ title: "two" })].join("\n") + "\n"
  );
  assert.deepEqual(queuedTitles(), ["one", "two"], "skips the corrupt line");

  const briefDir = path.join(process.cwd(), "briefings");
  fs.mkdirSync(briefDir, { recursive: true });
  const now = new Date(2026, 7, 3, 8, 0, 0);
  fs.writeFileSync(path.join(briefDir, `brief-${localDateKey(now)}.md`), "# brief");
  assert.equal(hasMorningBrief(now, briefDir), true, "finds today's briefing file");
  assert.equal(hasMorningBrief(new Date(2026, 7, 4, 8, 0, 0), briefDir), false, "not tomorrow's");
});
