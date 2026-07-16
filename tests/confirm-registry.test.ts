import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * W3 executor-registry tests. The registry makes a pending action DURABLE: it
 * persists as {kind, payload} and is run at confirm time by a server-registered
 * executor for that kind, so a confirm survives an app restart (unlike the
 * legacy RAM-closure path). We prove: filing + confirm runs the registered
 * executor; a "restart" (fresh module instance reading the same disk file)
 * still runs it; TTL/depth-1 still hold; and honest-failure text is spoken.
 */

// Isolate cwd BEFORE importing — the pending file lives under cwd/data.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-registry-test-"));
process.chdir(CWD);
fs.mkdirSync(path.join(CWD, "data"), { recursive: true });

const T0 = 1_000_000_000_000;
const PENDING_FILE = path.join(CWD, "data", "pending-action.json");

const confirmMod = await import("../lib/confirm.ts");
const {
  fileConfirm,
  requestConfirm,
  hasPending,
  pendingDescription,
  confirmPending,
  cancelPending,
  registerExecutor,
} = confirmMod;

function reset() {
  cancelPending(T0);
}

test("registry: file → hasPending → confirm runs the registered executor", async () => {
  reset();
  let ran = 0;
  let seenPayload: unknown = null;
  registerExecutor("test-kind", async (payload) => {
    ran++;
    seenPayload = payload;
    return "test executor ran";
  });

  const { pendingId, description, nonce } = fileConfirm(
    { kind: "test-kind", payload: { v: 42 }, description: "do the test thing" },
    { now: T0 }
  );
  assert.ok(pendingId);
  assert.equal(description, "do the test thing");
  assert.equal(hasPending(T0), true);
  assert.equal(pendingDescription(T0), "do the test thing");

  const r = await confirmPending(T0 + 1000, { nonce });
  assert.equal(r.ran, true);
  assert.equal(r.text, "test executor ran");
  assert.equal(ran, 1);
  assert.deepEqual(seenPayload, { v: 42 });
  // Single-shot: a second confirm is a no-op.
  assert.equal((await confirmPending(T0 + 1000, { nonce })).ran, false);
  assert.equal(hasPending(T0 + 1000), false);
});

test("registry: SURVIVES a restart — payload record on disk still runs", async () => {
  reset();
  // Simulate the durable path: write a {kind,payload} record to disk exactly as
  // fileConfirm would, but do NOT go through the live module's Map at all.
  const rec = {
    pendingId: "pending-restart-1",
    kind: "restart-kind",
    description: "an action filed before a restart",
    ts: T0,
    ttlMs: 120_000,
    payload: { hello: "world" },
  };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(rec));

  // Import a FRESH instance of the module (a cache-busting query) to mimic a
  // process that just started with only the disk file — no RAM closure exists.
  // @ts-expect-error — query-string module specifier is a Node runtime trick.
  const fresh = await import("../lib/confirm.ts?restart=1");
  let ran = 0;
  let payload: unknown = null;
  fresh.registerExecutor("restart-kind", async (p: unknown) => {
    ran++;
    payload = p;
    return "recovered after restart";
  });

  // The fresh instance sees the pending action purely from disk.
  assert.equal(fresh.hasPending(T0 + 500), true);
  const r = await fresh.confirmPending(T0 + 500);
  assert.equal(r.ran, true);
  assert.equal(r.text, "recovered after restart");
  assert.equal(ran, 1);
  assert.deepEqual(payload, { hello: "world" });
  // File cleared after the single-shot confirm.
  assert.equal(fs.existsSync(PENDING_FILE), false);
});

test("registry: expired pending action does not run", async () => {
  reset();
  registerExecutor("ttl-kind", async () => "should not run");
  fileConfirm(
    { kind: "ttl-kind", payload: {}, description: "stale" },
    { now: T0, ttlMs: 120_000 }
  );
  // Past TTL.
  assert.equal(hasPending(T0 + 120_001), false);
  const r = await confirmPending(T0 + 120_001);
  assert.equal(r.ran, false);
});

test("registry: depth-1 — a second file replaces the first", async () => {
  reset();
  let firstRan = 0;
  let secondRan = 0;
  registerExecutor("first-kind", async () => {
    firstRan++;
    return "first";
  });
  registerExecutor("second-kind", async () => {
    secondRan++;
    return "second";
  });
  fileConfirm({ kind: "first-kind", payload: {}, description: "first ask" }, { now: T0 });
  const { nonce } = fileConfirm({ kind: "second-kind", payload: {}, description: "second ask" }, { now: T0 });
  assert.equal(pendingDescription(T0), "second ask");
  const r = await confirmPending(T0, { nonce });
  assert.equal(r.text, "second");
  assert.equal(firstRan, 0);
  assert.equal(secondRan, 1);
});

test("registry: a record with an UNREGISTERED kind fails safe (nothing runs)", async () => {
  reset();
  const rec = {
    pendingId: "pending-orphan-1",
    kind: "no-such-executor",
    description: "orphaned",
    ts: T0,
    ttlMs: 120_000,
    payload: {},
  };
  fs.writeFileSync(PENDING_FILE, JSON.stringify(rec));
  // No executor registered for this kind → not runnable → treated as empty.
  assert.equal(hasPending(T0), false);
  assert.equal((await confirmPending(T0)).ran, false);
});

test("legacy closure path works in-process and fails safe on restart", async () => {
  reset();
  let ran = 0;
  const { nonce } = requestConfirm(
    {
      kind: "closure-kind",
      description: "closure ask",
      execute: async () => {
        ran++;
        return "closure ran";
      },
    },
    { now: T0 }
  );
  assert.equal(hasPending(T0), true);
  // Same instance still holds the closure → it runs.
  const r = await confirmPending(T0, { nonce });
  assert.equal(r.ran, true);
  assert.equal(r.text, "closure ran");
  assert.equal(ran, 1);

  // Now the restart-safety property: a closure record on disk with NO matching
  // RAM closure is treated as dead. Write one directly (no live closure) and a
  // fresh module instance must refuse to run it and self-heal the slot.
  reset();
  fs.writeFileSync(
    PENDING_FILE,
    JSON.stringify({
      pendingId: "pending-closure-orphan",
      kind: "closure-kind",
      description: "orphaned closure",
      ts: T0,
      ttlMs: 120_000,
      // no payload key ⇒ closure record; no closure in any Map ⇒ dead
    })
  );
  // @ts-expect-error — query-string module specifier is a Node runtime trick.
  const fresh = await import("../lib/confirm.ts?closure-restart=1");
  assert.equal(fresh.hasPending(T0), false);
  assert.equal(fs.existsSync(PENDING_FILE), false); // self-healed
});
