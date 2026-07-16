import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireMic,
  hasLiveMic,
  activeMicOwners,
  liveMicCount,
  onMicPanic,
  panicMicRelease,
  __resetMicRegistryForTests,
} from "../lib/mic-registry.ts";

/**
 * The mic registry is the provable source of truth for "is the microphone
 * captured right now". These cases pin the guarantees the trust fix relies on:
 * a lease is live only between acquire and release, release is idempotent, and
 * panic drops everything unconditionally.
 */

function reset() {
  __resetMicRegistryForTests();
}

test("no live mic before anything is acquired", () => {
  reset();
  assert.equal(hasLiveMic(), false);
  assert.equal(liveMicCount(), 0);
  assert.deepEqual(activeMicOwners(), []);
});

test("acquire marks the mic live with the owner tag; release clears it", () => {
  reset();
  const lease = acquireMic("voice-chat");
  assert.equal(hasLiveMic(), true);
  assert.equal(lease.active, true);
  assert.deepEqual(activeMicOwners(), ["voice-chat"]);
  lease.release();
  assert.equal(hasLiveMic(), false);
  assert.equal(lease.active, false);
  assert.deepEqual(activeMicOwners(), []);
});

test("release is idempotent — double release is a safe no-op", () => {
  reset();
  const lease = acquireMic("voice-chat");
  lease.release();
  lease.release();
  assert.equal(hasLiveMic(), false);
  assert.equal(liveMicCount(), 0);
});

test("multiple owners are tracked independently", () => {
  reset();
  const a = acquireMic("voice-chat");
  const b = acquireMic("phone-web");
  assert.equal(liveMicCount(), 2);
  a.release();
  assert.deepEqual(activeMicOwners(), ["phone-web"]);
  b.release();
  assert.equal(hasLiveMic(), false);
});

test("panic fires every registered handler and force-drops every lease", () => {
  reset();
  const reasons: string[] = [];
  const off = onMicPanic((reason) => reasons.push(reason));
  acquireMic("voice-chat");
  acquireMic("phone-web");
  assert.equal(liveMicCount(), 2);
  panicMicRelease("pause");
  assert.equal(hasLiveMic(), false, "registry must be empty after panic");
  assert.deepEqual(reasons, ["pause"]);
  off();
});

test("panic force-drops a lease even if its handler forgets to release", () => {
  reset();
  // A handler that does NOT drop its lease — panic's backstop must still clear.
  onMicPanic(() => {
    /* buggy owner: no release() */
  });
  acquireMic("voice-chat");
  panicMicRelease();
  assert.equal(hasLiveMic(), false);
});

test("a throwing panic handler does not block others or the force-drop", () => {
  reset();
  const seen: string[] = [];
  onMicPanic(() => {
    throw new Error("boom");
  });
  onMicPanic((r) => seen.push(r));
  acquireMic("voice-chat");
  panicMicRelease("pagehide");
  assert.deepEqual(seen, ["pagehide"]);
  assert.equal(hasLiveMic(), false);
});

test("unsubscribed panic handlers stop firing", () => {
  reset();
  let calls = 0;
  const off = onMicPanic(() => calls++);
  off();
  panicMicRelease();
  assert.equal(calls, 0);
});
