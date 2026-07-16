import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionSwarms, SWARM_ATTENTION_STATUSES } from "../lib/swarm-view.ts";

/**
 * Sidebar swarm filter (R1). A worker stays in the left-nav strip ONLY while it
 * needs the owner's eyes — pending-approval or review-error. Merged/closed and
 * every in-flight/finished state drop off; a repo with nothing visible vanishes
 * entirely (merged tally included); an all-empty result renders no SWARM section.
 */

function repo(name: string, statuses: string[]) {
  return { repo: name, workers: statuses.map((status, i) => ({ status, branch: `b${i}` })) };
}

test("only pending-approval and review-error are attention statuses", () => {
  assert.deepEqual([...SWARM_ATTENTION_STATUSES].sort(), ["pending-approval", "review-error"]);
});

test("merged and closed workers disappear immediately", () => {
  const out = attentionSwarms([repo("demo-app", ["merged", "closed"])]);
  assert.equal(out.length, 0, "a repo with only merged/closed workers is not shown");
});

test("in-flight and other terminal states are also hidden (not just merged/rejected)", () => {
  // The old SWARM_DONE={merged,rejected} let closed/failed/needs-human/pr-open
  // linger forever — the exact bug this filter fixes.
  const out = attentionSwarms([
    repo("x", ["working", "pending", "pr-open", "failed", "merge-failed", "needs-human", "rejected", "stalled"]),
  ]);
  assert.equal(out.length, 0);
});

test("pending-approval stays; review-error stays (errors need eyes)", () => {
  const out = attentionSwarms([repo("vidi-chat", ["pending-approval", "review-error", "merged", "working"])]);
  assert.equal(out.length, 1);
  assert.deepEqual(
    out[0].visible.map((w) => w.status),
    ["pending-approval", "review-error"]
  );
});

test("merged tally reflects the whole repo but only shows alongside visible workers", () => {
  const out = attentionSwarms([
    repo("a", ["merged", "merged", "pending-approval"]), // 2 merged + 1 visible → shown
    repo("b", ["merged", "merged"]), // all merged, nothing visible → dropped (tally gone too)
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].repo, "a");
  assert.equal(out[0].merged, 2);
});

test("all repos empty → empty result (caller renders no SWARM section)", () => {
  assert.equal(attentionSwarms([]).length, 0);
  assert.equal(attentionSwarms([repo("a", ["merged"]), repo("b", ["closed", "working"])]).length, 0);
});

test("worker generic shape is preserved (name/branch/pr survive the filter)", () => {
  const raw = [
    {
      repo: "r",
      workers: [
        { status: "pending-approval", branch: "swarm/x", name: "Aria", pr: 12 },
        { status: "merged", branch: "swarm/y", name: "Bo", pr: 13 },
      ],
    },
  ];
  const out = attentionSwarms(raw);
  assert.equal(out[0].visible.length, 1);
  assert.equal(out[0].visible[0].pr, 12);
  assert.equal(out[0].visible[0].name, "Aria");
});
