import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Weekly health summary: default-off, consent-gated send, 7-day dampening,
 * digest content = counts/categories/version only (no message text, no paths),
 * and the security notice reflects the toggle state.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-weekly-")));

const { recordDiag } = await import("../lib/diag-ledger.ts");
const {
  weeklySummaryConsent,
  setWeeklySummaryConsent,
  buildWeeklyDigest,
  maybeSendWeeklySummary,
} = await import("../lib/feedback.ts");
const { securityNoticeSections } = await import("../lib/security-notice.ts");

function writeVoiceKey() {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "data", "voice-key"), "vidi_live_wk");
}

test("consent is OFF by default and fail-closed on a garbage file", () => {
  assert.equal(weeklySummaryConsent(), false);
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "data", "feedback-consent.json"), "{ not json");
  assert.equal(weeklySummaryConsent(), false); // fail-closed
  setWeeklySummaryConsent(true);
  assert.equal(weeklySummaryConsent(), true);
  setWeeklySummaryConsent(false);
  assert.equal(weeklySummaryConsent(), false);
});

test("no send without consent (and no network)", async () => {
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const outcome = await maybeSendWeeklySummary(Date.now());
    assert.deepEqual(outcome, { sent: false, reason: "no-consent" });
    assert.equal(called, false, "no fetch attempted without consent");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("consent on but no key → no-key (no network)", async () => {
  setWeeklySummaryConsent(true);
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const outcome = await maybeSendWeeklySummary(1_000_000);
    assert.deepEqual(outcome, { sent: false, reason: "no-key" });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("consent on + key present → sends once, then 7-day dampening blocks a resend", async () => {
  setWeeklySummaryConsent(true);
  writeVoiceKey();
  const origFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const t0 = 2_000_000_000_000;
    const first = await maybeSendWeeklySummary(t0);
    assert.deepEqual(first, { sent: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.kind, "weekly-summary");
    assert.equal(typeof calls[0].body.text, "string");

    // Immediately again — inside the 7-day window → too-soon, no second fetch.
    const second = await maybeSendWeeklySummary(t0 + 60_000);
    assert.deepEqual(second, { sent: false, reason: "too-soon" });
    assert.equal(calls.length, 1, "no resend inside the week");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("digest carries counts/categories/version only — no message text, no paths", () => {
  const home = os.homedir();
  recordDiag("provider-fail", `died at ${home}/secret/place.ts token abcdef0123456789abcdef`);
  const digest = buildWeeklyDigest(3_000_000);
  // Report is JSON of counts; must not contain the scrubbed message or any path.
  assert.ok(!digest.report.includes(home));
  assert.ok(!digest.report.includes("/Users/") && !digest.report.includes("/home/"));
  assert.ok(!digest.report.includes("place.ts"), "no message text in the weekly digest");
  assert.ok(!digest.report.includes("secret"), "no message content leaks");
  // But it DOES carry the category count and the version.
  assert.ok(digest.report.includes("provider-fail"), "category count present");
  assert.ok(/errorsByCategory/.test(digest.report));
  assert.ok(/appBuild/.test(digest.report));
  assert.ok(/sessions/.test(digest.text), "compact stat row present");
});

test("security notice discloses the weekly summary only when the toggle is on", () => {
  const off = securityNoticeSections(true, false);
  const on = securityNoticeSections(true, true);
  const egressOff = off.find((s) => s.heading === "Where your information goes")!;
  const egressOn = on.find((s) => s.heading === "Where your information goes")!;
  const hasWeekly = (points: readonly string[]) =>
    points.some((p) => p.toLowerCase().includes("weekly"));
  assert.equal(hasWeekly(egressOff.points), false, "no weekly disclosure when off");
  assert.equal(hasWeekly(egressOn.points), true, "weekly disclosure present when on");
});
