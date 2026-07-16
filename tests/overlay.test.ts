import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverlay } from "../lib/overlay.ts";

// A fleet agent whose feed/model/threadId carry sensitive content that must
// NEVER reach the public stream overlay.
const dirtyAgent: any = {
  id: "secret-thread-uuid-1234",
  name: "Marshall",
  provider: "claude",
  model: "sonnet",
  mode: "act",
  status: "working",
  createdAt: 1,
  lastActivity: 2,
  turns: 3,
  tokens: { input: 5000, output: 2500 },
  feed: [
    { type: "user", ts: 1, text: "here is my SECRET prompt about /Users/example/.ssh/id_rsa" },
    { type: "tool", ts: 2, tool: "Bash", summary: "cat /Users/example/workspace/keys.rtf" },
  ],
};

test("overlay whitelists fields — no feed/prompt/path/model/id leaks", () => {
  const data = buildOverlay([dirtyAgent], { day: 7, revenueUsd: 1200, goalUsd: 10000 });
  const json = JSON.stringify(data);
  // sanity: the safe fields are present
  assert.equal(data.day, 7);
  assert.equal(data.revenueUsd, 1200);
  assert.equal(data.agents[0].name, "Marshall");
  assert.equal(data.agents[0].tokensOut, 2500);
  assert.equal(data.workingCount, 1);
  // the dangerous stuff must be ABSENT
  assert.ok(!json.includes("SECRET"), "prompt text leaked");
  assert.ok(!json.includes("/Users/"), "file path leaked");
  assert.ok(!json.includes(".ssh"), "secret path leaked");
  assert.ok(!json.includes("keys.rtf"), "secret file leaked");
  assert.ok(!json.includes("secret-thread-uuid"), "thread id leaked");
  assert.ok(!json.includes("sonnet"), "model leaked");
  assert.ok(!json.includes("feed"), "feed key leaked");
  // the overlay agent object has EXACTLY the whitelisted keys
  assert.deepEqual(Object.keys(data.agents[0]).sort(), ["name", "status", "tokensOut", "turns"]);
});

test("overlay day computed from startDateMs when day absent", () => {
  const now = 10 * 24 * 3600_000; // 10 days after epoch
  const data = buildOverlay([], { startDateMs: 0 }, now);
  assert.equal(data.day, 11); // day 1 is the start day
  assert.equal(data.goalUsd, 10000); // default goal
  assert.equal(data.agents.length, 0);
});
