import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// goals.ts resolves data/ off process.cwd() (goals.json + goal-events.jsonl),
// so chdir into a fresh temp dir BEFORE importing — same isolation pattern as
// policy.test.ts. The MyWiki mirror writes to an absolute path outside cwd; it
// fails open if that dir is unwritable, which is fine under test.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-goals-test-")));

const { addGoal, listGoals, getGoal, setGoalStatus, tickGoals } = await import(
  "../lib/goals.ts"
);
import type { TickDeps, VerifyResult } from "../lib/goals.ts";

// A fresh cwd per test keeps goals.json / goal-events.jsonl empty and isolated.
function freshCwd() {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-goals-")));
}

// These tests are async AND isolate via process.chdir — a process-global. The
// node:test runner starts top-level tests concurrently, so without serializing
// them one test's chdir could bleed into another's pending awaits. serial()
// chains every test body through a shared tail promise so exactly one runs at a
// time; each body chdir's first, then owns cwd until it resolves.
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  });
}

// Deps that NEVER spawn a real agent or run a real command. Each test overrides
// only the dimension it targets.
function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    isKillEngaged: () => false,
    quotaHot: () => false,
    runLoop: async () => "done",
    verify: async (): Promise<VerifyResult> => ({ code: 0, output: "ok" }),
    // Default: return a plan; tests that assert on planning override this to
    // count calls. Never spawns a real CLI — the default adapter is not used.
    runPlan: async () => "# Plan\n1. do the thing\n2. verify\n",
    now: () => Date.now(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Ledger CRUD + status transitions
// ---------------------------------------------------------------------------

serial("addGoal creates, slugifies, and dedupes; listGoals/getGoal read back", () => {
  freshCwd();
  const g = addGoal({ title: "Keep Ops Dashboard Green!", description: "no red tiles" });
  assert.equal(g.slug, "keep-ops-dashboard-green");
  assert.equal(g.status, "active");
  assert.equal(g.budget.maxIterations, 4);
  assert.equal(g.budget.maxTicksPerDay, 3);

  // Same title → same goal, not a duplicate.
  const again = addGoal({ title: "Keep Ops Dashboard Green!" });
  assert.equal(again.id, g.id);
  assert.equal(listGoals().length, 1);

  const fetched = getGoal("keep-ops-dashboard-green");
  assert.equal(fetched?.id, g.id);
  assert.equal(getGoal("nope"), null);
});

serial("setGoalStatus transitions active → paused → active", () => {
  freshCwd();
  addGoal({ title: "coverage goal" });
  assert.equal(setGoalStatus("coverage-goal", "paused")?.status, "paused");
  assert.equal(getGoal("coverage-goal")?.status, "paused");
  assert.equal(setGoalStatus("coverage-goal", "active")?.status, "active");
  assert.equal(setGoalStatus("missing", "paused"), null);
});

// ---------------------------------------------------------------------------
// Tick: runs an active goal
// ---------------------------------------------------------------------------

serial("tick runs an active goal: loop DONE + verify pass → done", async () => {
  freshCwd();
  addGoal({ title: "ship the thing", verifyCmd: "true" });

  let loopCalls = 0;
  let verifyCalls = 0;
  const res = await tickGoals(
    deps({
      runLoop: async (opts) => {
        loopCalls++;
        // Prompt is plan-grounded and names the agent via the tick, not here.
        assert.match(opts.goal, /ship the thing/);
        assert.equal(opts.maxIterations, 4);
        return "done";
      },
      verify: async (cmd) => {
        verifyCalls++;
        assert.equal(cmd, "true");
        return { code: 0, output: "all green" };
      },
    })
  );

  assert.equal(loopCalls, 1);
  assert.equal(verifyCalls, 1);
  assert.equal(res.ran, true);
  assert.equal(res.results[0].status, "done");
  assert.equal(getGoal("ship-the-thing")?.status, "done");

  // Outcome was appended to the event ledger.
  const events = fs.readFileSync(path.join(process.cwd(), "data", "goal-events.jsonl"), "utf8");
  assert.match(events, /"status":"done"/);
});

// ---------------------------------------------------------------------------
// False-DONE: verify fails → blocked, not done (the NightShift principle)
// ---------------------------------------------------------------------------

serial("false DONE: loop says done but verifyCmd exits non-zero → blocked, not done", async () => {
  freshCwd();
  addGoal({ title: "risky goal", verifyCmd: "exit 1" });

  const res = await tickGoals(
    deps({
      runLoop: async () => "done",
      verify: async () => ({ code: 1, output: "3 tests failed" }),
    })
  );

  assert.equal(res.results[0].status, "blocked");
  assert.match(res.results[0].note, /verify exited 1/);
  assert.equal(res.results[0].evidence, "3 tests failed");
  const goal = getGoal("risky-goal");
  assert.equal(goal?.status, "blocked");
  assert.notEqual(goal?.status, "done");
  assert.equal(goal?.lastTick?.evidence, "3 tests failed");
});

// ---------------------------------------------------------------------------
// Checkpoint goal: unconfirmed checkpoint holds it at blocked even on verify pass
// ---------------------------------------------------------------------------

serial("checkpoint goal: verify passes but an unconfirmed checkpoint holds it at blocked", async () => {
  freshCwd();
  addGoal({
    title: "deploy to prod",
    verifyCmd: "true",
    checkpoints: [{ desc: "the owner approves the release", requiresConfirm: true }],
  });

  const res = await tickGoals(
    deps({ runLoop: async () => "done", verify: async () => ({ code: 0, output: "" }) })
  );

  assert.equal(res.results[0].status, "blocked");
  assert.match(res.results[0].note, /checkpoint needs/i);
  assert.equal(getGoal("deploy-to-prod")?.status, "blocked");
});

// ---------------------------------------------------------------------------
// Global deferrals: kill-engaged and quota-hot both skip the whole sweep
// ---------------------------------------------------------------------------

serial("kill engaged: tick defers, no loop runs", async () => {
  freshCwd();
  addGoal({ title: "some goal" });
  let loopCalls = 0;
  const res = await tickGoals(
    deps({ isKillEngaged: () => true, runLoop: async () => (loopCalls++, "done") })
  );
  assert.equal(res.ran, false);
  assert.equal(res.results.length, 0);
  assert.equal(loopCalls, 0);
});

serial("quota hot: tick defers, no loop runs", async () => {
  freshCwd();
  addGoal({ title: "some goal" });
  let loopCalls = 0;
  const res = await tickGoals(
    deps({ quotaHot: () => true, runLoop: async () => (loopCalls++, "done") })
  );
  assert.equal(res.ran, false);
  assert.equal(loopCalls, 0);
});

// ---------------------------------------------------------------------------
// Per-goal daily budget + at-most-two-active-per-tick
// ---------------------------------------------------------------------------

serial("daily budget: a goal is skipped once maxTicksPerDay real ticks are logged", async () => {
  freshCwd();
  addGoal({ title: "busy goal" }); // no verifyCmd → done accepted at face value
  const fixedNow = Date.now();
  // Default budget is 3 ticks/day. Run 3 real ticks, then a 4th must skip.
  for (let i = 0; i < 3; i++) {
    const r = await tickGoals(deps({ now: () => fixedNow, runLoop: async () => "cap" }));
    // "cap" → progress; goal stays active so it's eligible again next tick.
    assert.equal(r.results[0].status, "progress");
  }
  const fourth = await tickGoals(deps({ now: () => fixedNow, runLoop: async () => "cap" }));
  assert.equal(fourth.results[0].status, "skipped");
  assert.match(fourth.results[0].note, /daily tick budget/i);
});

serial("at most two active goals get a loop per tick", async () => {
  freshCwd();
  addGoal({ title: "goal one" });
  addGoal({ title: "goal two" });
  addGoal({ title: "goal three" });
  let loopCalls = 0;
  const res = await tickGoals(deps({ runLoop: async () => (loopCalls++, "cap") }));
  assert.equal(loopCalls, 2);
  assert.equal(res.results.length, 2);
});

// ---------------------------------------------------------------------------
// Loop outcomes without verify
// ---------------------------------------------------------------------------

serial("loop BLOCKED sets the goal blocked; loop error claims no progress", async () => {
  freshCwd();
  addGoal({ title: "blockable" });
  const blocked = await tickGoals(deps({ runLoop: async () => "blocked" }));
  assert.equal(blocked.results[0].status, "blocked");
  assert.equal(getGoal("blockable")?.status, "blocked");

  freshCwd();
  addGoal({ title: "errory" });
  const errored = await tickGoals(deps({ runLoop: async () => "error" }));
  // An internal loop stop is progress-with-no-claim, and leaves status active.
  assert.equal(errored.results[0].status, "progress");
  assert.equal(getGoal("errory")?.status, "active");
});

// ---------------------------------------------------------------------------
// Plan phase (W4): a stale/missing plan gets ONE plan turn before the loop.
// ---------------------------------------------------------------------------

function planFilePath(slug: string): string {
  return path.join(process.cwd(), "data", "goals", slug, "plan.md");
}

serial("plan phase: a goal with no plan gets one plan turn, file written + goal.plan set", async () => {
  freshCwd();
  addGoal({ title: "coverage goal", verifyCmd: "true" });

  let planCalls = 0;
  const res = await tickGoals(
    deps({
      runPlan: async (goal) => {
        planCalls++;
        assert.equal(goal.slug, "coverage-goal");
        return "# Working plan\n1. add tests\n2. run verify\n";
      },
      runLoop: async () => "cap", // progress, keeps the goal active
    })
  );

  assert.equal(planCalls, 1, "exactly one plan turn");
  assert.equal(res.results[0].status, "progress");

  // Plan file written and goal.plan recorded with the file path.
  const plan = getGoal("coverage-goal")?.plan;
  assert.ok(plan, "goal.plan is set");
  assert.equal(plan!.path, planFilePath("coverage-goal"));
  assert.ok(plan!.refreshedAt > 0);
  assert.match(fs.readFileSync(plan!.path, "utf8"), /add tests/);
});

serial("plan phase: a fresh plan is NOT re-run next tick (no churn)", async () => {
  freshCwd();
  addGoal({ title: "steady goal" });

  const first = await tickGoals(deps({ runPlan: async () => "# plan v1\n", runLoop: async () => "cap" }));
  assert.equal(first.results[0].status, "progress");
  assert.ok(getGoal("steady-goal")?.plan, "plan set on first tick");

  // Second tick same day: plan is fresh (< 48h) → runPlan must not fire again.
  let planCalls = 0;
  await tickGoals(
    deps({
      runPlan: async () => (planCalls++, "# plan v2\n"),
      runLoop: async () => "cap",
    })
  );
  assert.equal(planCalls, 0, "fresh plan is not regenerated");
});

serial("plan phase: a stale plan (>48h) is refreshed", async () => {
  freshCwd();
  addGoal({ title: "aging goal" });

  const t0 = Date.now();
  await tickGoals(deps({ now: () => t0, runPlan: async () => "# old plan\n", runLoop: async () => "cap" }));
  assert.ok(getGoal("aging-goal")?.plan);

  // 49h later → stale → one refresh turn, file rewritten.
  const t1 = t0 + 49 * 60 * 60 * 1000;
  let planCalls = 0;
  await tickGoals(
    deps({
      now: () => t1,
      runPlan: async () => (planCalls++, "# refreshed plan\n"),
      runLoop: async () => "cap",
    })
  );
  assert.equal(planCalls, 1, "stale plan is refreshed once");
  const plan = getGoal("aging-goal")?.plan;
  assert.equal(plan!.refreshedAt, t1);
  assert.match(fs.readFileSync(plan!.path, "utf8"), /refreshed plan/);
});

serial("plan phase: confirming a checkpoint re-plans on the next tick", async () => {
  freshCwd();
  addGoal({
    title: "gated goal",
    checkpoints: [{ desc: "the owner approves", requiresConfirm: true }],
  });

  const t0 = Date.now();
  await tickGoals(deps({ now: () => t0, runPlan: async () => "# plan\n", runLoop: async () => "blocked" }));
  const before = getGoal("gated-goal")?.plan;
  assert.ok(before?.checkpointSig, "checkpointSig recorded");
  // The goal went blocked (checkpoint holds it); reactivate + clear the gate
  // to simulate the owner confirming, WITHOUT waiting 48h.
  const goals = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "goals.json"), "utf8")
  );
  goals[0].status = "active";
  goals[0].checkpoints[0].requiresConfirm = false;
  fs.writeFileSync(path.join(process.cwd(), "data", "goals.json"), JSON.stringify(goals));

  // Same-day tick: plan is <48h old but the checkpoint sig changed → re-plan.
  let planCalls = 0;
  await tickGoals(
    deps({
      now: () => t0 + 60_000,
      runPlan: async () => (planCalls++, "# post-confirm plan\n"),
      runLoop: async () => "cap",
    })
  );
  assert.equal(planCalls, 1, "checkpoint confirmation triggers a re-plan");
});

serial("plan phase: a plan-turn failure is non-fatal — the loop still runs", async () => {
  freshCwd();
  addGoal({ title: "resilient goal", verifyCmd: "true" });

  let loopCalls = 0;
  const res = await tickGoals(
    deps({
      runPlan: async () => null, // plan turn failed
      runLoop: async () => (loopCalls++, "done"),
    })
  );
  assert.equal(loopCalls, 1, "loop runs even though planning failed");
  assert.equal(res.results[0].status, "done");
  assert.equal(getGoal("resilient-goal")?.plan, undefined, "no plan recorded on failure");
});

// ---------------------------------------------------------------------------
// Re-arm lifecycle: a "done" goal is not a terminal dead-end.
// ---------------------------------------------------------------------------

function goalsJsonPath(): string {
  return path.join(process.cwd(), "data", "goals.json");
}
function eventsJsonlPath(): string {
  return path.join(process.cwd(), "data", "goal-events.jsonl");
}

/** Seed a single done goal directly into goals.json with explicit re-arm state
 *  (addGoal only makes active goals, so re-arm needs a hand-built ledger). */
function seedDoneGoal(over: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(goalsJsonPath()), { recursive: true });
  const goal = {
    id: "goal-rearm-test",
    slug: "rearm-goal",
    title: "keep the thing green",
    description: "",
    status: "done",
    budget: { maxIterations: 2, maxTicksPerDay: 2 },
    verifyCmd: "true",
    rearmAfterHours: 24,
    lastVerify: 1_000_000,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  fs.writeFileSync(goalsJsonPath(), JSON.stringify([goal], null, 2));
  return goal;
}

serial("re-arm: fresh done goal (lastVerify recent) is NOT re-verified", async () => {
  freshCwd();
  const t = 1_000_000;
  seedDoneGoal({ lastVerify: t });
  let verifyCalls = 0;
  let loopCalls = 0;
  // 1h later, well under the 24h cadence.
  const res = await tickGoals(
    deps({
      now: () => t + 60 * 60 * 1000,
      verify: async () => (verifyCalls++, { code: 0, output: "" }),
      runLoop: async () => (loopCalls++, "done"),
    })
  );
  assert.equal(verifyCalls, 0, "not due → no re-verify");
  assert.equal(loopCalls, 0, "done goal runs no loop");
  assert.equal(res.results.length, 0, "nothing happened this tick");
  assert.equal(getGoal("rearm-goal")?.status, "done");
});

serial("re-arm: done→stale→re-verify PASS keeps it done, quietly, no loop/LLM", async () => {
  freshCwd();
  const t = 1_000_000;
  seedDoneGoal({ lastVerify: t });
  let verifyCalls = 0;
  let loopCalls = 0;
  const later = t + 25 * 60 * 60 * 1000; // > 24h cadence → stale
  const res = await tickGoals(
    deps({
      now: () => later,
      verify: async (cmd) => {
        verifyCalls++;
        assert.equal(cmd, "true");
        return { code: 0, output: "all green" };
      },
      runLoop: async () => (loopCalls++, "done"),
    })
  );
  assert.equal(verifyCalls, 1, "stale done goal is re-verified exactly once");
  assert.equal(loopCalls, 0, "quiet re-verify runs NO loop (no LLM spend)");
  assert.equal(res.results[0].status, "rearmed");
  const goal = getGoal("rearm-goal");
  assert.equal(goal?.status, "done", "still done after a passing re-verify");
  assert.equal(goal?.lastVerify, later, "lastVerify refreshed to now");
});

serial("re-arm: done→stale→re-verify FAIL reactivates and the loop works it", async () => {
  freshCwd();
  const t = 1_000_000;
  seedDoneGoal({ lastVerify: t });
  let loopCalls = 0;
  const later = t + 25 * 60 * 60 * 1000;
  const res = await tickGoals(
    deps({
      now: () => later,
      // First verify call = the re-arm re-verify (fails → reactivate). After the
      // loop runs, the loop-DONE path verifies again; keep it failing so the goal
      // ends this tick still needing work (blocked), which is the honest state.
      verify: async () => ({ code: 1, output: "2 tests red" }),
      runLoop: async () => (loopCalls++, "done"),
    })
  );
  // The re-arm result comes first, then the active-pass loop result — same tick.
  assert.equal(res.results[0].status, "reactivated");
  assert.match(res.results[0].note, /re-armed to active/);
  assert.equal(loopCalls, 1, "reactivated goal is looped THIS tick");
  // Loop said DONE but verify still fails → blocked (false-DONE guard).
  assert.equal(res.results[1].status, "blocked");
  const goal = getGoal("rearm-goal");
  assert.equal(goal?.status, "blocked");
  // lastVerify was NOT bumped by the failed re-verify — it shows the last real pass.
  assert.equal(goal?.lastVerify, t);
});

serial("re-arm: a passing quiet re-verify does NOT consume the daily tick budget", async () => {
  freshCwd();
  const t = 1_000_000;
  // maxTicksPerDay: 1 — a single loop tick is all this goal may spend per day.
  seedDoneGoal({ lastVerify: t, budget: { maxIterations: 2, maxTicksPerDay: 1 } });
  const later = t + 25 * 60 * 60 * 1000; // stale → re-verify fires

  // Tick A: stale → re-verify PASSES → logs "rearmed", stays done, NO loop. This
  // is the quiet re-verify whose event must not count against the daily budget.
  const resA = await tickGoals(
    deps({ now: () => later, verify: async () => ({ code: 0, output: "" }), runLoop: async () => "done" })
  );
  assert.equal(resA.results[0].status, "rearmed");

  // Now flip the (still-done) goal to active — as if the owner reopened it — and
  // confirm it still gets its full one-loop daily budget: the "rearmed" event
  // from Tick A must NOT have been counted.
  const goals = JSON.parse(fs.readFileSync(goalsJsonPath(), "utf8"));
  goals[0].status = "active";
  fs.writeFileSync(goalsJsonPath(), JSON.stringify(goals));

  let loopCalls = 0;
  const resB = await tickGoals(
    deps({ now: () => later, verify: async () => ({ code: 0, output: "" }), runLoop: async () => (loopCalls++, "cap") })
  );
  assert.equal(loopCalls, 1, "the quiet re-verify did not consume the day's one loop budget");
  assert.equal(resB.results[0].status, "progress");

  // The ledger carries a "rearmed" event that budget-counting must exclude.
  const events = fs.readFileSync(eventsJsonlPath(), "utf8");
  assert.match(events, /"status":"rearmed"/);
});

serial("re-arm: a done goal with no verifyCmd refreshes its clock and stays done", async () => {
  freshCwd();
  const t = 1_000_000;
  seedDoneGoal({ lastVerify: t, verifyCmd: undefined });
  const later = t + 25 * 60 * 60 * 1000;
  let verifyCalls = 0;
  const res = await tickGoals(
    deps({ now: () => later, verify: async () => (verifyCalls++, { code: 0, output: "" }) })
  );
  assert.equal(verifyCalls, 0, "nothing deterministic to re-check");
  assert.equal(res.results[0].status, "rearmed");
  assert.match(res.results[0].note, /no verifyCmd/);
  const goal = getGoal("rearm-goal");
  assert.equal(goal?.status, "done");
  assert.equal(goal?.lastVerify, later, "clock refreshed so it stops re-arming every tick");
});

serial("re-arm: a done goal with no rearmAfterHours stays terminal (legacy behavior)", async () => {
  freshCwd();
  const t = 1_000_000;
  seedDoneGoal({ lastVerify: t, rearmAfterHours: undefined });
  let verifyCalls = 0;
  const res = await tickGoals(
    deps({ now: () => t + 1000 * 60 * 60 * 24 * 30, verify: async () => (verifyCalls++, { code: 0, output: "" }) })
  );
  assert.equal(verifyCalls, 0, "no cadence → never re-arms even a month later");
  assert.equal(res.results.length, 0);
  assert.equal(getGoal("rearm-goal")?.status, "done");
});
