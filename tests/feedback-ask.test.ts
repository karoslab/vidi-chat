import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** ask-on-error: after N same-category failures in a session, offer once; never
 *  nag twice for the same category in a day. */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ask-")));

const { recordDiag, _resetSessionCounts } = await import("../lib/diag-ledger.ts");
const { shouldOfferReport, markCategoryOffered, ASK_ON_ERROR_THRESHOLD } = await import(
  "../lib/feedback.ts"
);

const DAY1 = Date.UTC(2026, 6, 11, 10, 0, 0);
const DAY2 = DAY1 + 25 * 60 * 60 * 1000; // next calendar day

test("does not offer below the threshold", () => {
  _resetSessionCounts();
  for (let i = 1; i < ASK_ON_ERROR_THRESHOLD; i++) recordDiag("provider-fail", `e${i}`);
  assert.equal(shouldOfferReport("provider-fail", DAY1), false);
});

test("offers once the threshold is reached", () => {
  recordDiag("provider-fail", "eN"); // now at the threshold
  assert.equal(shouldOfferReport("provider-fail", DAY1), true);
});

test("does not nag twice the same day after being offered", () => {
  markCategoryOffered("provider-fail", DAY1);
  assert.equal(shouldOfferReport("provider-fail", DAY1), false);
});

test("offers again on a new day (still over threshold)", () => {
  assert.equal(shouldOfferReport("provider-fail", DAY2), true);
});

test("a different category is tracked independently", () => {
  assert.equal(shouldOfferReport("tts-fail", DAY1), false); // no tts-fail recorded
});
