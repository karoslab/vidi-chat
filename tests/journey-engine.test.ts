import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JourneyStep, VerifyResult } from "../lib/journey/types.ts";

/**
 * The Vidi Journey engine — the never-get-lost core. Position is RECOMPUTED
 * every pass by running verify() down the registry and stopping at the first
 * failure; data/journey.json is only a cache and never decides position. These
 * tests pin: registry ordering, verify-driven resume position (with mock
 * failing steps), the first-failure-only rule (later steps go pending), throw
 * handling, single-step recheck, and cache-vs-recompute.
 */

// registry.ts writes the cache under dataDir() (cwd/data). Isolate to a temp cwd
// BEFORE importing — same pattern as onboarding.test.ts / goals.test.ts.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-eng-")));

const { getSteps, computeJourney, recheckStep, readJourneyCache } = await import(
  "../lib/journey/registry.ts"
);

// Serialize: compute() mutates the shared cache file. One at a time.
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

function mock(id: string, stage: number, result: VerifyResult): JourneyStep {
  return { id, stage, title: id, verify: async () => result };
}

// ── Registry ordering (the full wired registry) ─────────────────────────────
serial("registry wires all six stages in order behind the foundation steps", () => {
  const ids = getSteps().map((s) => s.id);
  assert.deepEqual(ids, [
    "vidi-running", //         stage 1
    "claude-connected", //     stage 2
    "onboarding-completed", // stage 2
    "memory-wiki", //          stage 3
    "memory-interview", //     stage 3
    "memory-bring-stuff", //   stage 3
    "github-connect", //       stage 4
    "approval-desk", //        stage 5
    "discord-mirror", //       stage 5
    "premium-voice", //        stage 6 (optional voice upgrade)
    "phone-access", //         stage 6
  ]);
  const stages = getSteps().map((s) => s.stage);
  // Non-decreasing stage numbers — resume walks in this order.
  for (let i = 1; i < stages.length; i++) assert.ok(stages[i] >= stages[i - 1]);
  assert.equal(stages[0], 1); // vidi-running is the anchor
  assert.equal(stages[stages.length - 1], 6); // phone access is the optional final stage
});

// ── Verify-driven resume position ──────────────────────────────────────────
serial("resume position is the FIRST failing step; later steps go pending", async () => {
  const steps = [
    mock("a", 1, { ok: true }),
    mock("b", 2, { ok: false, reason: "b is broken" }),
    mock("c", 3, { ok: true }), // would pass, but must NOT be evaluated after b fails
  ];
  const state = await computeJourney(steps);
  assert.equal(state.currentStepId, "b");
  assert.equal(state.complete, false);
  assert.equal(state.steps[0].status, "verified");
  assert.equal(state.steps[1].status, "failed");
  assert.equal(state.steps[1].reason, "b is broken");
  assert.equal(state.steps[2].status, "pending"); // the grey dash: waiting on b
});

serial("all-pass yields complete:true and no current step", async () => {
  const state = await computeJourney([mock("a", 1, { ok: true }), mock("b", 2, { ok: true })]);
  assert.equal(state.complete, true);
  assert.equal(state.currentStepId, null);
  assert.ok(state.steps.every((s) => s.status === "verified"));
});

serial("only the first failure is 'failed'; a later failure stays pending", async () => {
  const state = await computeJourney([
    mock("a", 1, { ok: true }),
    mock("b", 2, { ok: false, reason: "first" }),
    mock("c", 3, { ok: false, reason: "second" }),
  ]);
  assert.equal(state.currentStepId, "b");
  assert.equal(state.steps[1].status, "failed");
  assert.equal(state.steps[2].status, "pending"); // never reached, no reason surfaced
  assert.equal(state.steps[2].reason, undefined);
});

serial("a failure with no fixStepId defaults fixStepId to the step id", async () => {
  const state = await computeJourney([mock("solo", 1, { ok: false, reason: "nope" })]);
  assert.equal(state.steps[0].fixStepId, "solo");
});

serial("a verify() that throws is a soft failure, not a crash", async () => {
  const thrower: JourneyStep = {
    id: "boom",
    stage: 1,
    title: "boom",
    verify: async () => {
      throw new Error("kaboom");
    },
  };
  const state = await computeJourney([thrower]);
  assert.equal(state.currentStepId, "boom");
  assert.equal(state.steps[0].status, "failed");
  assert.match(state.steps[0].reason!, /could not run/i);
});

// ── Cache vs recompute ──────────────────────────────────────────────────────
serial("computeJourney writes data/journey.json as a cache of the pass", async () => {
  const state = await computeJourney([mock("a", 1, { ok: false, reason: "x" })]);
  const cached = readJourneyCache();
  assert.ok(cached);
  assert.equal(cached!.currentStepId, "a");
  assert.deepEqual(cached!.steps.map((s) => s.id), state.steps.map((s) => s.id));
  // The file really exists on disk.
  assert.ok(fs.existsSync(path.join(process.cwd(), "data", "journey.json")));
});

serial("recompute IGNORES a stale cache: position follows live verify, not the file", async () => {
  // First pass: everything broken → cache says currentStepId = "a".
  await computeJourney([mock("a", 1, { ok: false, reason: "broken" })]);
  assert.equal(readJourneyCache()!.currentStepId, "a");
  // The world changes: the same step now verifies. A recompute must report DONE,
  // even though the cache still holds the old failing pass at call time.
  const fresh = await computeJourney([mock("a", 1, { ok: true })]);
  assert.equal(fresh.complete, true);
  assert.equal(fresh.currentStepId, null);
  // And the cache is overwritten with the fresh truth (it never overrode it).
  assert.equal(readJourneyCache()!.currentStepId, null);
});

// ── Single-step recheck ─────────────────────────────────────────────────────
serial("recheckStep re-verifies one step and returns its fresh state", async () => {
  const steps = [mock("a", 1, { ok: true }), mock("b", 2, { ok: false, reason: "fix b" })];
  const a = await recheckStep("a", steps);
  assert.equal(a!.status, "verified");
  const b = await recheckStep("b", steps);
  assert.equal(b!.status, "failed");
  assert.equal(b!.reason, "fix b");
});

serial("recheckStep returns null for an unknown step id", async () => {
  const got = await recheckStep("does-not-exist", [mock("a", 1, { ok: true })]);
  assert.equal(got, null);
});
