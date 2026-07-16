import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SWARM_VALIDATE_STATUSES,
  reclassifyWorkerStatus,
} from "../lib/swarm-github.ts";
import { attentionSwarms } from "../lib/swarm-view.ts";

/**
 * FIX 2 — the swarm orchestrator never updates a worker's status after
 * `APPROVE PR n` merges the PR, so merged PRs sit at "pending-approval" /
 * "review-error" and wrongly show in the sidebar. reclassifyWorkerStatus
 * reconciles against real GitHub state (a fake PR-state map here).
 */

test("reclassify: MERGED/CLOSED drop the attention status; OPEN/unknown keep it (fail open)", () => {
  const states = new Map<string, string>([
    ["vidi-chat#24", "MERGED"],
    ["vidi-chat#7", "CLOSED"],
    ["vidi-chat#99", "OPEN"],
    ["myapp#5", "MERGED"],
  ]);
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "pending-approval", pr: 24 }, states), "merged");
  assert.equal(reclassifyWorkerStatus("myapp", { status: "review-error", pr: 5 }, states), "merged");
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "pending-approval", pr: 7 }, states), "closed");
  // OPEN → keep the orchestrator's status.
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "pending-approval", pr: 99 }, states), "pending-approval");
  // gh didn't return this PR (fail open) → keep.
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "pending-approval", pr: 404 }, states), "pending-approval");
  // pr == null → nothing to check → keep.
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "review-error", pr: null }, states), "review-error");
  // A non-attention status is never touched, even for a merged PR.
  assert.equal(reclassifyWorkerStatus("vidi-chat", { status: "working", pr: 24 }, states), "working");
});

test("the four currently-stale entries reclassify to merged → sidebar SWARM section goes empty", () => {
  // The exact live-stale state (verified via gh): all four are MERGED.
  const states = new Map<string, string>([
    ["vidi-chat#24", "MERGED"],
    ["vidi-chat#25", "MERGED"],
    ["vidi-chat#26", "MERGED"],
    ["myapp#5", "MERGED"],
  ]);
  const swarms = [
    {
      repo: "vidi-chat",
      workers: [
        { status: "pending-approval", pr: 24 },
        { status: "pending-approval", pr: 25 },
        { status: "pending-approval", pr: 26 },
      ],
    },
    {
      repo: "myapp",
      workers: [{ status: "review-error", pr: 5 }],
    },
  ];

  // Reclassify every worker, then run the sidebar's own attention filter.
  const reconciled = swarms.map((s) => ({
    repo: s.repo,
    workers: s.workers.map((w) => ({
      status: reclassifyWorkerStatus(s.repo, w, states),
    })),
  }));
  for (const s of reconciled) {
    for (const w of s.workers) {
      assert.ok(!SWARM_VALIDATE_STATUSES.has(w.status), `${s.repo} still attention: ${w.status}`);
    }
  }
  assert.deepEqual(attentionSwarms(reconciled), [], "SWARM section must be empty after reconciliation");
});
