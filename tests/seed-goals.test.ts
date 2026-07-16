import { test } from "node:test";
import assert from "node:assert/strict";

// Unit-tests the pure merge logic in bin/seed-goals.mjs directly (no
// subprocess, no filesystem) — importing the module has no side effect
// (main() only runs when invoked as a script, guarded by the
// import.meta.url === file://process.argv[1] check), so this is safe to
// import from a test without ever touching a real data/goals.json.
const { mergeGoals, definitionChanged, DEFS, REPO } = await import("../bin/seed-goals.mjs");

const DEF_A = DEFS[0]; // vidi-chat-suite-health

function fixedId() {
  return "goal-fixed-id";
}

test("mergeGoals: empty ledger → all three DEFS created active", () => {
  const goals: any[] = [];
  const summary = mergeGoals(goals, DEFS, 1000, fixedId);
  assert.equal(goals.length, 3);
  assert.ok(goals.every((g) => g.status === "active"));
  assert.ok(goals.every((g) => g.createdAt === 1000 && g.updatedAt === 1000));
  assert.ok(summary.every((s) => /^created/.test(s)));
});

test("mergeGoals: idempotent — running twice with unchanged DEFS does not duplicate or bump updatedAt", () => {
  const goals: any[] = [];
  mergeGoals(goals, DEFS, 1000, fixedId);
  assert.equal(goals.length, 3);

  const summary2 = mergeGoals(goals, DEFS, 5000, fixedId);
  assert.equal(goals.length, 3, "no duplicates on a second run");
  assert.ok(
    summary2.every((s) => /^unchanged/.test(s)),
    "second run with identical DEFS reports unchanged, not updated"
  );
  // updatedAt must NOT move — nothing about the definition changed.
  for (const g of goals) {
    assert.equal(g.updatedAt, 1000, `${g.slug} updatedAt must stay at first-run value`);
  }
});

test("mergeGoals: preserves runtime fields on a mid-flight goal (done, with plan/lastVerify/lastTick)", () => {
  const goals: any[] = [
    {
      id: "goal-real-id",
      slug: DEF_A.slug,
      title: "stale title",
      description: "stale description",
      status: "done",
      budget: { maxIterations: 99, maxTicksPerDay: 99 },
      verifyCmd: "cd /old/stale/path/vidi-chat && npm test", // the stale path
      createdAt: 1,
      updatedAt: 1,
      lastVerify: 12345,
      lastTick: { ts: 12345, status: "done", note: "loop DONE and verify passed" },
      plan: { path: "/some/plan.md", refreshedAt: 1 },
    },
  ];
  mergeGoals(goals, DEFS, 9999, fixedId);

  assert.equal(goals.length, 3, "no duplicate of the existing slug");
  const merged = goals.find((g) => g.slug === DEF_A.slug);
  // Definition fields updated to the signed-off DEFS (incl. the path fix).
  assert.equal(merged.title, DEF_A.title);
  assert.equal(merged.verifyCmd, DEF_A.verifyCmd);
  assert.equal(merged.verifyCmd, `cd ${REPO} && npm test`);
  assert.equal(merged.rearmAfterHours, DEF_A.rearmAfterHours);
  assert.deepEqual(merged.budget, DEF_A.budget);
  // Runtime fields preserved verbatim — status, id, clocks, plan, lastTick.
  assert.equal(merged.id, "goal-real-id");
  assert.equal(merged.status, "done");
  assert.equal(merged.createdAt, 1);
  assert.equal(merged.lastVerify, 12345);
  assert.deepEqual(merged.lastTick, { ts: 12345, status: "done", note: "loop DONE and verify passed" });
  assert.deepEqual(merged.plan, { path: "/some/plan.md", refreshedAt: 1 });
  // updatedAt DID move here because the definition genuinely changed (stale
  // path, title, budget) — distinguishing this from the untouched no-op case.
  assert.equal(merged.updatedAt, 9999);
});

test("mergeGoals: preserves a blocked/active mid-loop goal untouched by definition, no updatedAt bump", () => {
  const goals: any[] = [
    {
      id: "goal-real-id-2",
      slug: DEF_A.slug,
      title: DEF_A.title,
      description: DEF_A.description,
      status: "blocked",
      budget: { ...DEF_A.budget },
      verifyCmd: DEF_A.verifyCmd,
      rearmAfterHours: DEF_A.rearmAfterHours,
      createdAt: 1,
      updatedAt: 1,
      lastTick: { ts: 500, status: "blocked", note: "loop reported BLOCKED" },
    },
  ];
  mergeGoals(goals, DEFS, 9999, fixedId);
  const merged = goals.find((g) => g.slug === DEF_A.slug);
  assert.equal(merged.status, "blocked", "mid-flight status untouched");
  assert.deepEqual(merged.lastTick, { ts: 500, status: "blocked", note: "loop reported BLOCKED" });
  assert.equal(merged.updatedAt, 1, "nothing about the definition changed — updatedAt must not move");
});

test("definitionChanged: detects a changed verifyCmd, budget, or rearmAfterHours; ignores runtime-only diffs", () => {
  const existing = {
    title: DEF_A.title,
    description: DEF_A.description,
    verifyCmd: DEF_A.verifyCmd,
    rearmAfterHours: DEF_A.rearmAfterHours,
    budget: { ...DEF_A.budget },
    status: "done", // runtime field — must not affect the comparison
    lastVerify: 42, // runtime field — must not affect the comparison
  };
  assert.equal(definitionChanged(existing, DEF_A), false);
  assert.equal(definitionChanged({ ...existing, verifyCmd: "old path" }, DEF_A), true);
  assert.equal(
    definitionChanged({ ...existing, budget: { maxIterations: 1, maxTicksPerDay: 1 } }, DEF_A),
    true
  );
  assert.equal(definitionChanged({ ...existing, rearmAfterHours: 1 }, DEF_A), true);
});

test("DEFS: vidi-chat-suite-health verifyCmd is derived from REPO (this checkout's own location), not a hardcoded personal path", () => {
  assert.equal(DEF_A.verifyCmd, `cd ${REPO} && npm test`);
  assert.doesNotMatch(DEF_A.verifyCmd, /Hermes/);
});
