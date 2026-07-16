import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workingCaption,
  ringSlots,
  fleetChips,
  workingCount,
} from "../lib/orbit.ts";

/**
 * Orbit home derivation (feat/orbit-redesign). The solar-system home is wired to
 * real threads/swarm/agent data; these lock the pure math behind it — caption
 * grammar, ring geometry, and the swarm/agent → outer-orbit chip reduction.
 */

test("caption: zero working agents is the calm case", () => {
  assert.equal(workingCaption(0), "Everything is quiet.");
});

test("caption: one uses singular subject/verb", () => {
  assert.equal(workingCaption(1), "Everything is quiet. One agent is working.");
});

test("caption: small counts are spelled out and pluralized", () => {
  assert.equal(workingCaption(2), "Everything is quiet. Two agents are working.");
  assert.equal(workingCaption(5), "Everything is quiet. Five agents are working.");
});

test("caption: past ten falls back to digits, negatives clamp to quiet", () => {
  assert.equal(workingCaption(12), "Everything is quiet. 12 agents are working.");
  assert.equal(workingCaption(-3), "Everything is quiet.");
});

test("ringSlots: four items land at the cardinal points, 12 o'clock first", () => {
  const s = ringSlots(4);
  assert.equal(s.length, 4);
  const round = (n: number) => Math.round(n);
  assert.deepEqual({ x: round(s[0].xPct), y: round(s[0].yPct) }, { x: 50, y: 0 }); // top
  assert.deepEqual({ x: round(s[1].xPct), y: round(s[1].yPct) }, { x: 100, y: 50 }); // right
  assert.deepEqual({ x: round(s[2].xPct), y: round(s[2].yPct) }, { x: 50, y: 100 }); // bottom
  assert.deepEqual({ x: round(s[3].xPct), y: round(s[3].yPct) }, { x: 0, y: 50 }); // left
});

test("ringSlots: startDeg rotates the whole set", () => {
  const s = ringSlots(1, 90);
  assert.equal(Math.round(s[0].xPct), 100);
  assert.equal(Math.round(s[0].yPct), 50);
});

test("ringSlots: empty for non-positive counts", () => {
  assert.deepEqual(ringSlots(0), []);
  assert.deepEqual(ringSlots(-2), []);
});

test("workingCount: sums working agents and working swarm workers", () => {
  const n = workingCount({
    swarms: [
      { repo: "kbrain", workers: [{ status: "working", pr: null }, { status: "merged", pr: 1 }] },
    ],
    agents: [{ name: "Aria", status: "working" }, { name: "Bo", status: "idle" }],
  });
  assert.equal(n, 2);
});

test("fleetChips: working repo → amber pulsing working chip", () => {
  const chips = fleetChips({
    swarms: [{ repo: "kbrain", workers: [{ status: "working", pr: null }] }],
    agents: [],
  });
  assert.equal(chips.length, 1);
  assert.deepEqual(chips[0], {
    key: "swarm:kbrain",
    label: "swarm: kbrain · 1 working",
    dot: "working",
    pulse: true,
  });
});

test("fleetChips: pr-open repo shows PR number and in review", () => {
  const chips = fleetChips({
    swarms: [{ repo: "demo-app", workers: [{ status: "pr-open", pr: 41 }] }],
    agents: [],
  });
  assert.equal(chips[0].label, "PR #41 · in review");
  assert.equal(chips[0].dot, "pr-open");
  assert.equal(chips[0].pulse, false);
});

test("fleetChips: pending-approval review pulses for the eyes it needs", () => {
  const chips = fleetChips({
    swarms: [{ repo: "vidi-chat", workers: [{ status: "pending-approval", pr: 9 }] }],
    agents: [],
  });
  assert.equal(chips[0].pulse, true);
  assert.equal(chips[0].dot, "pr-open");
});

test("fleetChips: all-merged repo shows the merged tally, green, no pulse", () => {
  const chips = fleetChips({
    swarms: [{ repo: "demo-app", workers: [{ status: "merged", pr: 1 }, { status: "merged", pr: 2 }] }],
    agents: [],
  });
  assert.deepEqual(chips[0], {
    key: "swarm:demo-app",
    label: "swarm: demo-app · 2 merged",
    dot: "merged",
    pulse: false,
  });
});

test("fleetChips: working beats review beats merged for a repo's single chip", () => {
  const chips = fleetChips({
    swarms: [
      {
        repo: "mix",
        workers: [
          { status: "merged", pr: 1 },
          { status: "pr-open", pr: 2 },
          { status: "working", pr: null },
        ],
      },
    ],
    agents: [],
  });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].dot, "working");
});

test("fleetChips: idle-only repo is dropped; working agents become chips", () => {
  const chips = fleetChips({
    swarms: [{ repo: "quiet", workers: [{ status: "closed", pr: null }] }],
    agents: [{ name: "Nyx", status: "working" }, { name: "Ida", status: "idle" }],
  });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].key, "agent:Nyx");
  assert.equal(chips[0].dot, "working");
});

test("fleetChips: capped so the ring never overflows", () => {
  const chips = fleetChips(
    {
      swarms: [
        { repo: "a", workers: [{ status: "working", pr: null }] },
        { repo: "b", workers: [{ status: "working", pr: null }] },
      ],
      agents: [
        { name: "c", status: "working" },
        { name: "d", status: "working" },
        { name: "e", status: "working" },
      ],
    },
    3
  );
  assert.equal(chips.length, 3);
});
