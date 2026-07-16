import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JourneyStep, VerifyResult } from "../lib/journey/types.ts";

/**
 * Journey INTEGRATION test — the whole registry wired together (memory Stage 3,
 * GitHub Stage 4, approvals Stage 5 registered behind the three foundation
 * steps). It walks the REAL registry order with MOCKED verify() functions to
 * prove three things end to end:
 *   1. ordering — the full 10-step registry, stage-monotonic 1→6,
 *   2. resume position — the first genuinely failing step is the resume point
 *      and everything after it goes pending,
 *   3. the optional-step skip path — the skippable Discord mirror never blocks:
 *      a failing skippable step is "skipped", not the resume point, and a later
 *      required step is still evaluated.
 *
 * Isolate the cache to a temp cwd BEFORE importing (registry writes data/
 * journey.json under dataDir() = cwd/data); HOME / workspace are pointed at temp
 * dirs too so importing the real step modules never touches real state.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-int-home-"));
process.env.HOME = HOME;
process.env.VIDI_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-int-ws-"));
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-int-")));

const { getSteps, computeJourney } = await import("../lib/journey/registry.ts");

// The full registry, in the order the engine walks it. This is the whole point
// of the integration pass: every stage's steps, wired in, in order.
const EXPECTED: [string, number][] = [
  ["vidi-running", 1],
  ["claude-connected", 2],
  ["onboarding-completed", 2],
  ["memory-wiki", 3],
  ["memory-interview", 3],
  ["memory-bring-stuff", 3],
  ["github-connect", 4],
  ["approval-desk", 5],
  ["discord-mirror", 5],
  ["premium-voice", 6],
  ["phone-access", 6],
];

/** Wrap every real step with a scripted verify() so the walk is deterministic,
 *  while keeping the real id / stage / skippable metadata from the registry. */
function walkWith(results: Record<string, VerifyResult>): readonly JourneyStep[] {
  return getSteps().map((s) => ({ ...s, verify: async () => results[s.id] ?? { ok: true } }));
}

const OK: VerifyResult = { ok: true };

// ── 1. Ordering ─────────────────────────────────────────────────────────────
test("the full registry is wired in stage order (foundation → memory → github → approvals)", () => {
  const got = getSteps().map((s) => [s.id, s.stage] as [string, number]);
  assert.deepEqual(got, EXPECTED);
  const stages = getSteps().map((s) => s.stage);
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i] >= stages[i - 1], "stage numbers are non-decreasing");
  }
});

test("the skippable steps are github-connect + discord-mirror + premium-voice + phone-access; every step is a real object", () => {
  const skippable = getSteps().filter((s) => s.skippable).map((s) => s.id);
  assert.deepEqual(skippable, ["github-connect", "discord-mirror", "premium-voice", "phone-access"]);
  for (const s of getSteps()) {
    assert.equal(typeof s.verify, "function");
    assert.equal(typeof s.title, "string");
  }
});

// ── 2. Everything green ───────────────────────────────────────────────────────
test("all steps verify → complete, no resume point, nothing skipped", async () => {
  const state = await computeJourney(walkWith({}));
  assert.equal(state.complete, true);
  assert.equal(state.currentStepId, null);
  assert.deepEqual(state.steps.map((s) => s.id), EXPECTED.map(([id]) => id));
  assert.ok(state.steps.every((s) => s.status === "verified"));
});

// ── 3. Resume position (verify-driven) ────────────────────────────────────────
test("resume position is the first genuinely failing step; later steps go pending", async () => {
  // Use a NON-skippable failing step (memory-wiki) — a failing skippable step
  // (github-connect) is recorded 'skipped' and is never the resume point.
  const state = await computeJourney(
    walkWith({ "memory-wiki": { ok: false, reason: "not set up yet" } })
  );
  assert.equal(state.currentStepId, "memory-wiki");
  assert.equal(state.complete, false);
  // everything before memory-wiki verified
  for (const id of ["vidi-running", "claude-connected", "onboarding-completed"]) {
    assert.equal(state.steps.find((s) => s.id === id)!.status, "verified", `${id} verified`);
  }
  assert.equal(state.steps.find((s) => s.id === "memory-wiki")!.status, "failed");
  // steps AFTER the failure wait on it — even the skippable ones are pending
  // here, because the journey never reached them this pass.
  assert.equal(state.steps.find((s) => s.id === "github-connect")!.status, "pending");
  assert.equal(state.steps.find((s) => s.id === "approval-desk")!.status, "pending");
  assert.equal(state.steps.find((s) => s.id === "discord-mirror")!.status, "pending");
});

// ── 4. The optional-step skip path ────────────────────────────────────────────
test("a failing skippable Discord step is 'skipped', never the resume point, and does not block completion", async () => {
  const state = await computeJourney(
    walkWith({
      "discord-mirror": {
        ok: false,
        reason: "Discord isn't connected yet. You can set it up or skip it.",
        fixStepId: "discord-mirror",
      },
    })
  );
  const discord = state.steps.find((s) => s.id === "discord-mirror")!;
  assert.equal(discord.status, "skipped");
  assert.equal(discord.reason, "Discord isn't connected yet. You can set it up or skip it.");
  // The skip does NOT stop the journey: no resume point, journey is complete.
  assert.equal(state.currentStepId, null);
  assert.equal(state.complete, true);
});

test("a skippable failure in the MIDDLE does not block a later required step", async () => {
  // Synthetic ordering (mocked steps): skippable step fails between two required
  // ones. The engine must skip it and still EVALUATE the step after it.
  const steps: JourneyStep[] = [
    { id: "a", stage: 1, title: "a", verify: async () => OK },
    { id: "opt", stage: 2, title: "opt", skippable: true, verify: async () => ({ ok: false, reason: "optional" }) },
    { id: "b", stage: 3, title: "b", verify: async () => OK },
  ];
  const state = await computeJourney(steps);
  assert.equal(state.steps[1].status, "skipped");
  assert.equal(state.steps[2].status, "verified", "the required step after the skip is still evaluated");
  assert.equal(state.currentStepId, null);
  assert.equal(state.complete, true);
});

test("a skippable step that PASSES verify is a normal verified step", async () => {
  const state = await computeJourney(walkWith({ "discord-mirror": { ok: true, note: "connected" } }));
  assert.equal(state.steps.find((s) => s.id === "discord-mirror")!.status, "verified");
  assert.equal(state.complete, true);
});
