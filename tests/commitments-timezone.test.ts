// Regression tests for the commitment `due` timezone contract (Batch B).
//
// The `due` field is free-form model output ("2026-07-11", "2026-07-11T17:00:00")
// consumed by BOTH this parser and the ops event producer
// (ops/tasks/event_producers.py `_coerce_due_ms`). The two halves MUST agree, or
// the spoken "due now" reminder fires at a different instant than the evening
// wrap treats the promise as due. This file pins the audit repros:
//   * a naive ISO datetime is LOCAL wall-clock (not UTC — the 5-6h-early firing).
//   * a bare calendar date is due END of that LOCAL day (not UTC midnight, which
//     west of UTC is 19:00 the PREVIOUS evening).
//
// TZ is pinned to America/Chicago (the owner's zone, CDT = UTC-5 in July) BEFORE
// the module is imported so the "previous evening" bug is reproduced
// deterministically regardless of the CI machine's clock. node --test runs each
// test file in its own process, so this does not leak into other suites.
process.env.TZ = "America/Chicago";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ledger resolves its path off process.cwd()+"/data"; isolate cwd into a
// fresh temp dir BEFORE importing (same pattern as commitments.test.ts).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-commitments-tz-test-")));
const { addCommitment, dueCommitments, somedayCommitments } = await import(
  "../lib/commitments.ts"
);

function freshCwd(tag: string): void {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), `vidi-commitments-tz-${tag}-`)));
}

test("date-only due is due END of that LOCAL day, never the previous evening", () => {
  freshCwd("date-only");
  // Natural model emission for "I'll do it tomorrow": a bare calendar date.
  addCommitment({ text: "renew the domain", due: "2026-07-11" });

  // THE BUG: JS Date.parse('2026-07-11') = Jul 11 00:00 UTC = Jul 10 19:00 CDT,
  // so the old code surfaced it as due from 20:00 the PRIOR evening. Under the
  // pinned CDT zone this assertion fails on the old code and passes on the fix.
  const priorEvening = new Date(2026, 6, 10, 20, 0, 0); // Jul 10 20:00 local
  assert.equal(
    dueCommitments(priorEvening).length,
    0,
    "a date-only promise must NOT be due the evening before its date"
  );

  // Nor is it due at midday of its actual date — end-of-day semantics mean the
  // whole local day must pass first.
  const middayOfDueDate = new Date(2026, 6, 11, 12, 0, 0); // Jul 11 12:00 local
  assert.equal(dueCommitments(middayOfDueDate).length, 0);

  // It IS due once the local day has ended.
  const nextMidnight = new Date(2026, 6, 12, 0, 0, 0); // Jul 12 00:00 local
  const due = dueCommitments(nextMidnight);
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "renew the domain");
});

test("naive ISO datetime due is LOCAL wall-clock, not UTC (no 5-6h-early firing)", () => {
  freshCwd("naive-dt");
  // A 5pm-local promise written as a naive ISO datetime (no zone).
  addCommitment({ text: "send the report", due: "2026-07-11T17:00:00" });

  // If parsed as UTC (the ops bug), 17:00 UTC = 12:00 CDT, so it would be due
  // at noon local. Assert it is NOT due at 16:00 local — an hour before 5pm.
  const oneHourBefore = new Date(2026, 6, 11, 16, 0, 0); // Jul 11 16:00 local
  assert.equal(
    dueCommitments(oneHourBefore).length,
    0,
    "a naive 5pm datetime must be treated as 5pm LOCAL, not 5pm UTC"
  );

  // Due exactly at (and after) 17:00 local.
  const atFivePm = new Date(2026, 6, 11, 17, 0, 0); // Jul 11 17:00 local
  const due = dueCommitments(atFivePm);
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "send the report");
});

test("offset-carrying due keeps its explicit zone (unchanged behavior)", () => {
  freshCwd("offset");
  // 09:00 UTC = 04:00 CDT. An explicit zone is honored on both halves.
  addCommitment({ text: "deploy on friday", due: "2026-07-10T09:00:00Z" });

  const beforeUtc = new Date(Date.UTC(2026, 6, 10, 8, 0, 0)); // 08:00 UTC
  assert.equal(dueCommitments(beforeUtc).length, 0);

  const afterUtc = new Date(Date.UTC(2026, 6, 10, 10, 0, 0)); // 10:00 UTC
  assert.equal(dueCommitments(afterUtc).length, 1);
});

// --- QA review follow-up (PR #46 needs-fix) --------------------------------
//
// 1. Malformed date-only rollover: the multi-argument Date constructor
//    silently rolls an out-of-range month/day into the following month
//    ("2026-02-30" -> Mar 2) instead of rejecting it, while Python's
//    datetime(...) raises ValueError on the same input. Both halves must
//    agree that a malformed date is undatable (null / never auto-due), not
//    fire a reminder for a date that was never real.
// 2. Non-ISO datetime shapes: Date.parse alone accepts shapes Python's
//    fromisoformat rejects ("July 11, 2026", "07/11/2026", unpadded
//    "2026-7-11") and reads them as local midnight; the fix requires an
//    ISO-shaped string before falling back to Date.parse so both halves
//    agree these are undatable too.
// somedayCommitments (not dueCommitments) is the correct probe for "null" —
// it isolates open-but-undatable promises regardless of any particular `now`.

test("malformed date-only rollovers are undatable, never fire a reminder", () => {
  freshCwd("rollover");
  // Measured in review: each of these would roll over to a real-looking (but
  // wrong) date under the naive multi-arg Date constructor.
  const malformed = [
    "2026-02-30", // -> old bug: rolls to Mar 2
    "2026-13-45", // -> old bug: rolls to Feb 14 2027
    "2026-00-10", // -> old bug: rolls to Dec 10 2025
    "2026-07-32", // -> old bug: rolls to Aug 1
  ];
  for (const due of malformed) {
    addCommitment({ text: `bad date ${due}`, due });
  }

  // Never due, at any point in the future.
  assert.equal(dueCommitments(new Date(2099, 0, 1)).length, 0);
  // And correctly bucketed as "someday" (undatable), not silently dropped.
  const someday = somedayCommitments(new Date(2026, 6, 3, 12));
  assert.equal(someday.length, malformed.length);
});

test("non-ISO datetime shapes are undatable, matching Python's fromisoformat", () => {
  freshCwd("non-iso");
  const nonIso = [
    "2026-7-11", // unpadded month/day
    "July 11, 2026", // prose date
    "07/11/2026", // slash date
  ];
  for (const due of nonIso) {
    addCommitment({ text: `non-iso ${due}`, due });
  }

  assert.equal(dueCommitments(new Date(2099, 0, 1)).length, 0);
  const someday = somedayCommitments(new Date(2026, 6, 3, 12));
  assert.equal(someday.length, nonIso.length);
});

test("DST spring-forward: date-only end-of-day lands at the measured epoch", () => {
  freshCwd("dst");
  // 2026-03-08 is the US spring-forward date (CST -> CDT at 2am local).
  // End-of-day (23:59:59.999) falls after the transition, so it's in CDT
  // (UTC-5) — verified against the review's measured value.
  addCommitment({ text: "dst edge case", due: "2026-03-08" });

  const expectedEpochMs = 1773032399999;
  const justBefore = new Date(expectedEpochMs - 1);
  const justAfter = new Date(expectedEpochMs + 1);
  assert.equal(dueCommitments(justBefore).length, 0);
  assert.equal(dueCommitments(justAfter).length, 1);
});
