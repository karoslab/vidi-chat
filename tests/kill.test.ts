import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ before the module computes its cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-kill-test-")));
const {
  clearKill,
  engageKill,
  isKillEngaged,
  killStatus,
  listRuns,
  matchKillCommand,
  registerRun,
} = await import("../lib/kill.ts");

test("matchKillCommand grammar", () => {
  // engage — terse panic commands (filler/wake-word/urgency stripped)
  for (const phrase of [
    "vidi, stop everything",
    "STOP EVERYTHING NOW",
    "stop everything right now",
    "emergency stop",
    "hit the kill switch",
    "engage the kill switch",
    "abort everything please",
    "stop all agents",
    "kill all the agents",
    "kill everything",
  ]) {
    assert.equal(matchKillCommand(phrase), "engage", phrase);
  }
  // clear
  for (const phrase of [
    "clear the kill switch",
    "vidi, disengage the kill switch",
    "release kill switch",
    "reset the killswitch",
  ]) {
    assert.equal(matchKillCommand(phrase), "clear", phrase);
  }
  // neither — everyday sentences and QUESTIONS ABOUT the switch must not trip
  // it (a false engage writes a persistent panic file blocking all runs).
  for (const phrase of [
    "stop the dev server",
    "kill the process on port 3000",
    "what did you do today",
    "switch to the demo-app repo",
    "stop",
    "kill-switch", // bare noun, no verb — ambiguous, must not match
    "how does the kill switch work?",
    "explain the kill switch",
    "is the kill switch on?",
    "stop everything and summarize the repo",
    "kill everything in /tmp",
    "kill everything on port 3000",
  ]) {
    assert.equal(matchKillCommand(phrase), null, phrase);
  }
});

test("engage kills registered children and persists across module state", () => {
  const killedPids: number[] = [];
  const fakeChild = (pid: number) => ({
    kill: () => {
      killedPids.push(pid);
      return true;
    },
  });
  registerRun(
    { pid: 111, threadId: "t1", provider: "claude", startedAt: Date.now() },
    fakeChild(111)
  );
  registerRun(
    { pid: 222, threadId: "t2", provider: "codex", startedAt: Date.now() },
    fakeChild(222)
  );
  assert.equal(listRuns().length, 2);

  const { killed } = engageKill("unit test");
  assert.equal(killed, 2);
  assert.deepEqual(killedPids.sort(), [111, 222]);
  assert.equal(listRuns().length, 0);
  assert.equal(isKillEngaged(), true);
  const status = killStatus();
  assert.equal(status.engaged, true);
  assert.equal(status.reason, "unit test");

  assert.equal(clearKill(), true);
  assert.equal(isKillEngaged(), false);
  assert.equal(clearKill(), false); // second clear: nothing to remove
});

test("engageKill survives throwing and already-dead children", () => {
  const killed: number[] = [];
  registerRun(
    { pid: 401, threadId: "t1", provider: "claude", startedAt: Date.now() },
    { kill: () => { throw new Error("ESRCH"); } }
  );
  registerRun(
    { pid: 402, threadId: "t2", provider: "claude", startedAt: Date.now() },
    { kill: () => false } // already dead
  );
  registerRun(
    { pid: 403, threadId: "t3", provider: "codex", startedAt: Date.now() },
    { kill: () => { killed.push(403); return true; } }
  );
  const res = engageKill("resilience test");
  assert.equal(res.killed, 1); // only the real kill counts
  assert.deepEqual(killed, [403]);
  assert.equal(listRuns().length, 0); // all evicted regardless
  assert.equal(isKillEngaged(), true);
  clearKill();
});

test("deregister is identity-safe under PID reuse", () => {
  const oldChild = { kill: () => true };
  const unregisterOld = registerRun(
    { pid: 500, threadId: "old", provider: "claude", startedAt: Date.now() },
    oldChild
  );
  // PID 500 gets reused by a new run before the old unregister fires.
  registerRun(
    { pid: 500, threadId: "new", provider: "claude", startedAt: Date.now() },
    { kill: () => true }
  );
  unregisterOld(); // must NOT evict the new run
  assert.equal(listRuns().length, 1);
  assert.equal(listRuns()[0].threadId, "new");
  engageKill("cleanup");
  clearKill();
});

test("deregister removes a run from the registry", () => {
  const unregister = registerRun(
    { pid: 333, threadId: "t3", provider: "claude", startedAt: Date.now() },
    { kill: () => true }
  );
  assert.equal(listRuns().length, 1);
  unregister();
  assert.equal(listRuns().length, 0);
});
