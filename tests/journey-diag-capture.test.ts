import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JourneyStep } from "../lib/journey/types.ts";

/**
 * Observe-only wiring: a journey step's verify() throwing records a
 * `journey-verify-fail` ledger entry (lib/journey/registry.ts runOne's soft-
 * failure backstop) without changing the returned StepState/behavior — matches
 * tests/journey-engine.test.ts's "a verify() that throws is a soft failure"
 * case, plus asserts the ledger side effect and that it's scrubbed.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-diag-")));

const { computeJourney } = await import("../lib/journey/registry.ts");
const { readRecentDiag, diagCategoryCounts } = await import("../lib/diag-ledger.ts");

test("a throwing verify() records journey-verify-fail, scrubbed, without changing the StepState", async () => {
  const home = os.homedir();
  const thrower: JourneyStep = {
    id: "throwy-step",
    stage: 1,
    title: "Throwy",
    verify: async () => {
      throw new Error(`boom at ${home}/secret/place.ts token abcdef0123456789abcdef`);
    },
  };

  const state = await computeJourney([thrower]);

  // Behavior unchanged: same soft-failure StepState the existing engine test pins.
  assert.equal(state.steps[0].status, "failed");
  assert.equal(
    state.steps[0].reason,
    "This check could not run just now. Try Check again in a moment."
  );

  // Observe-only side effect: the ledger recorded it, scrubbed.
  const counts = diagCategoryCounts();
  assert.equal(counts["journey-verify-fail"], 1);
  const recent = readRecentDiag(1);
  assert.equal(recent[0].category, "journey-verify-fail");
  assert.ok(recent[0].message.includes("throwy-step"), "step id kept for context");
  assert.ok(!recent[0].message.includes(home), "no home path on disk");
  assert.ok(!/abcdef0123456789abcdef/.test(recent[0].message), "no hex token on disk");
});

test("an ordinary ok:false result does NOT record a journey-verify-fail entry", async () => {
  const notYet: JourneyStep = {
    id: "not-yet-step",
    stage: 1,
    title: "Not Yet",
    verify: async () => ({ ok: false, reason: "Not connected yet." }),
  };
  await computeJourney([notYet]);
  const counts = diagCategoryCounts();
  // Only the prior test's throw should be counted — an expected "not yet"
  // result is normal onboarding progress, not a diagnostics-worthy failure.
  assert.equal(counts["journey-verify-fail"], 1);
});
