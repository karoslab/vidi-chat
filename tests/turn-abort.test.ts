import { test } from "node:test";
import assert from "node:assert/strict";

const { registerTurnAbort, stopTurn } = await import("../lib/turn-abort.ts");

test("stopTurn aborts the registered controller and reports it was found", () => {
  const controller = new AbortController();
  registerTurnAbort("t1", controller);
  assert.equal(stopTurn("t1"), true);
  assert.equal(controller.signal.aborted, true);
});

test("stopTurn on a thread with nothing registered reports false, no throw", () => {
  assert.equal(stopTurn("no-such-thread"), false);
});

test("stopTurn after unregister reports false", () => {
  const controller = new AbortController();
  const unregister = registerTurnAbort("t2", controller);
  unregister();
  assert.equal(stopTurn("t2"), false);
  assert.equal(controller.signal.aborted, false);
});

test("unregister is identity-safe: a stale unregister must not evict a newer registration", () => {
  const first = new AbortController();
  const unregisterFirst = registerTurnAbort("t3", first);
  const second = new AbortController();
  registerTurnAbort("t3", second); // a new turn registers before the old one's cleanup runs
  unregisterFirst(); // must NOT evict `second`
  assert.equal(stopTurn("t3"), true);
  assert.equal(second.signal.aborted, true);
  assert.equal(first.signal.aborted, false); // the stale controller was never touched
});

test("registering a new controller for the same thread replaces the old one", () => {
  const first = new AbortController();
  registerTurnAbort("t4", first);
  const second = new AbortController();
  registerTurnAbort("t4", second);
  assert.equal(stopTurn("t4"), true);
  assert.equal(second.signal.aborted, true);
  assert.equal(first.signal.aborted, false);
});
