import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// These suites model the OWNER install (owner-default identity in prompts
// and brain paths). The customer identity contract is pinned in user-config.test.ts.
process.env.VIDI_OWNER = "1";


/**
 * W3 gws runtime scope-gating. Before an email send or calendar create, the
 * executor checks the GRANTED scopes; if the write scope is missing it returns
 * an honest, speakable failure ("re-authorize Google") instead of attempting
 * the write and never prompts for consent from the server. The owner grants the
 * scope out-of-band; the ~5-min cache picks it up.
 *
 * We drive the scope answer with VIDI_GWS_SCOPES_OVERRIDE so the test never
 * touches the real gws CLI or the network.
 */

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-gws-test-"));
process.chdir(CWD);
fs.mkdirSync(path.join(CWD, "data"), { recursive: true });

const T0 = 1_000_000_000_000;

const {
  GMAIL_SEND_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  hasScope,
  grantedScopes,
  clearScopeCache,
  ensureRfc3339Offset,
  buildGmailSendArgs,
  buildCalendarInsertArgs,
  createCalendarEvent,
} = await import("../lib/gws.ts");

// The confirm module registers the executors on import.
const { fileConfirm, confirmPending, cancelPending } = await import(
  "../lib/confirm.ts"
);

// The reauth message now addresses the configured user (the resolved
// displayName); a personal checklist tail was dropped as
// part of de-owner-ifying the prompt/spoken strings for a second user. The
// expected name is sourced from the config default so this never restates the
// owner's literal name.
const { DEFAULT_USER_CONFIG } = await import("../lib/user-config.ts");
const REAUTH = `I need ${DEFAULT_USER_CONFIG.displayName} to re-authorize Google first.`;

test("hasScope reflects the override list", async () => {
  process.env.VIDI_GWS_SCOPES_OVERRIDE = "email,profile";
  clearScopeCache();
  assert.equal(await hasScope(GMAIL_SEND_SCOPE), false);
  assert.equal(await hasScope(CALENDAR_EVENTS_SCOPE), false);

  process.env.VIDI_GWS_SCOPES_OVERRIDE = `email,${GMAIL_SEND_SCOPE},${CALENDAR_EVENTS_SCOPE}`;
  clearScopeCache();
  assert.equal(await hasScope(GMAIL_SEND_SCOPE), true);
  assert.equal(await hasScope(CALENDAR_EVENTS_SCOPE), true);
});

test("gws-email executor speaks the honest failure when the send scope is missing", async () => {
  cancelPending(T0);
  // Only readonly scopes granted — exactly the pre-K5 state today.
  process.env.VIDI_GWS_SCOPES_OVERRIDE =
    "email,https://www.googleapis.com/auth/gmail.readonly";

  const { nonce } = fileConfirm(
    {
      kind: "gws-email",
      payload: { to: "mom@example.com", subject: "hi", body: "running late" },
      description: "email Mom",
    },
    { now: T0 }
  );
  const r = await confirmPending(T0, { nonce });
  assert.equal(r.ran, true);
  assert.equal(r.text, REAUTH);
});

test("gws-calendar executor speaks the honest failure when the events scope is missing", async () => {
  cancelPending(T0);
  process.env.VIDI_GWS_SCOPES_OVERRIDE =
    "email,https://www.googleapis.com/auth/calendar.readonly";

  const { nonce } = fileConfirm(
    {
      kind: "gws-calendar",
      payload: { summary: "Dentist", start: "2026-07-10T10:00:00", end: "" },
      description: "add Dentist to your calendar",
    },
    { now: T0 }
  );
  const r = await confirmPending(T0, { nonce });
  assert.equal(r.ran, true);
  assert.equal(r.text, REAUTH);

  delete process.env.VIDI_GWS_SCOPES_OVERRIDE;
  clearScopeCache();
});

test("ensureRfc3339Offset: naive local dateTime gains this machine's DST-correct offset", () => {
  // Google rejected the bare model-produced time live on 2026-07-09
  // ("Missing time zone definition for start time").
  const naive = "2026-07-10T17:00:00";
  const out = ensureRfc3339Offset(naive);
  assert.match(out, /^2026-07-10T17:00:00[+-]\d{2}:\d{2}$/);
  // The appended offset must be the machine's offset FOR THAT DATE (DST-aware),
  // exactly as Date interprets the naive string as local time.
  const expectedMinutes = -new Date(naive).getTimezoneOffset();
  const sign = expectedMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(expectedMinutes);
  const expectedSuffix = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  assert.equal(out, `${naive}${expectedSuffix}`);
  // Winter vs summer dates may differ under DST; the offset must always be
  // the one Date computes for THAT date, never a hardcoded "today" offset.
  const winter = "2026-01-10T17:00:00";
  const winterMinutes = -new Date(winter).getTimezoneOffset();
  const winterSign = winterMinutes >= 0 ? "+" : "-";
  const winterAbs = Math.abs(winterMinutes);
  const winterSuffix = `${winterSign}${String(Math.floor(winterAbs / 60)).padStart(2, "0")}:${String(winterAbs % 60).padStart(2, "0")}`;
  assert.equal(ensureRfc3339Offset(winter), `${winter}${winterSuffix}`);
});

test("ensureRfc3339Offset: values already carrying a zone pass through untouched", () => {
  assert.equal(ensureRfc3339Offset("2026-07-10T17:00:00Z"), "2026-07-10T17:00:00Z");
  assert.equal(ensureRfc3339Offset("2026-07-10T17:00:00+05:30"), "2026-07-10T17:00:00+05:30");
  assert.equal(ensureRfc3339Offset("2026-07-10T17:00:00-0700"), "2026-07-10T17:00:00-0700");
  assert.equal(ensureRfc3339Offset("  2026-07-10T17:00:00Z  "), "2026-07-10T17:00:00Z");
});

test("ensureRfc3339Offset: date-only and garbage pass through for the API to report honestly", () => {
  assert.equal(ensureRfc3339Offset("2026-07-10"), "2026-07-10");
  assert.equal(ensureRfc3339Offset("Tomorrow at 5"), "Tomorrow at 5");
  assert.equal(ensureRfc3339Offset(""), "");
});

// --- Batch A items 3 / 35: seconds-less datetime gets valid RFC3339 seconds ---

test("ensureRfc3339Offset: a seconds-less 'T17:00' gains ':00' AND the offset", () => {
  // Without the seconds fill the output was "2026-07-10T17:00-05:00" — NOT valid
  // RFC3339 (partial-time requires HH:MM:SS), which Google rejects post-confirm.
  const out = ensureRfc3339Offset("2026-07-10T17:00");
  assert.match(out, /^2026-07-10T17:00:00[+-]\d{2}:\d{2}$/);
});

// --- Batch A item 19: space-separated local datetime is normalized to T form --

test("ensureRfc3339Offset: a space-separated '2026-07-10 17:00:00' becomes zoned RFC3339", () => {
  const out = ensureRfc3339Offset("2026-07-10 17:00:00");
  assert.match(out, /^2026-07-10T17:00:00[+-]\d{2}:\d{2}$/);
  // And the seconds-less space form is filled too.
  assert.match(ensureRfc3339Offset("2026-07-10 17:00"), /^2026-07-10T17:00:00[+-]\d{2}:\d{2}$/);
});

// --- Batch A items 4 / 34: a date-only start speaks a refusal, no doomed send --

test("createCalendarEvent: a date-only start returns a speakable ask, never shells out", async () => {
  // A date-only "block Friday" start would ship as a zone-less dateTime Google
  // rejects AFTER the confirm. It must return a spoken ask, not throw/attempt.
  const spoken = await createCalendarEvent({
    summary: "Block the day",
    start: "2026-07-11",
    end: "2026-07-11",
  });
  assert.equal(
    spoken,
    "I need a time of day for that event — what time should it start?"
  );
});

// --- Batch A items 0 / 1 / 2 / 3: hyphen-safe joined args + cc/bcc forwarded ---

test("buildGmailSendArgs: every value uses the hyphen-safe '--flag=value' form", () => {
  const args = buildGmailSendArgs({
    to: "a@x.com",
    subject: "list",
    body: "- milk\n- rent",
  });
  // A bulleted body starting with '-' as a SEPARATE token crashed clap (exit 3)
  // AFTER the confirm. The joined form is the verified fix.
  assert.ok(args.includes("--body=- milk\n- rent"), JSON.stringify(args));
  assert.ok(args.includes("--to=a@x.com"));
  assert.ok(args.includes("--subject=list"));
  // No bare value token is passed separately (clap would reject a leading '-').
  assert.ok(!args.includes("- milk\n- rent"));
  assert.ok(!args.includes("--body"));
});

test("buildGmailSendArgs: cc/bcc are forwarded only when present", () => {
  const withCc = buildGmailSendArgs({
    to: "a@x.com",
    subject: "s",
    body: "b",
    cc: "c@x.com",
    bcc: "d@x.com",
  });
  assert.ok(withCc.includes("--cc=c@x.com"));
  assert.ok(withCc.includes("--bcc=d@x.com"));
  // Absent cc/bcc emit no flag at all (they were silently dropped before).
  const noCc = buildGmailSendArgs({ to: "a@x.com", subject: "s", body: "b" });
  assert.ok(!noCc.some((a) => a.startsWith("--cc")));
  assert.ok(!noCc.some((a) => a.startsWith("--bcc")));
});

test("buildCalendarInsertArgs: hyphen-safe joined form for summary/start/end", () => {
  const args = buildCalendarInsertArgs({
    summary: "- standup",
    start: "2026-07-10T17:00:00-05:00",
    end: "2026-07-10T18:00:00-05:00",
  });
  assert.ok(args.includes("--summary=- standup"), JSON.stringify(args));
  assert.ok(args.includes("--start=2026-07-10T17:00:00-05:00"));
  assert.ok(!args.includes("--summary"));
});

// --- QA follow-up (post-#47 review): sibling of finding 34, date-only END -----

test("createCalendarEvent: a TIMED start with a date-only end also speaks a refusal", async () => {
  // Only the START guard existed; a timed start + date-only end ("start 5pm,
  // end 2026-07-11") still shipped --end=2026-07-11 zone-less and Google
  // rejected it post-confirm — same never-executed class, just the other field.
  const spoken = await createCalendarEvent({
    summary: "Standup",
    start: "2026-07-10T17:00:00",
    end: "2026-07-11",
  });
  assert.equal(
    spoken,
    "I need a time of day for when that event ends — what time should it end?"
  );
});

