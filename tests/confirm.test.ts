import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pending-action file lives under process.cwd()+"/data", so isolate cwd
// into a fresh temp dir BEFORE importing the module (same pattern as
// policy.test.ts / store.test.ts). All tests share this one module instance,
// which is what lets us exercise the in-memory executor Map realistically.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-test-")));
const {
  requestConfirm,
  hasPending,
  pendingDescription,
  confirmPending,
  cancelPending,
} = await import("../lib/confirm.ts");

// A fixed clock so TTL tests are deterministic. Every call takes an optional
// `now`/`ttlMs`, so we never rely on the wall clock.
const T0 = 1_000_000_000_000;

// Each test starts from a clean slot: cancel drains anything a prior test left
// (module state is shared across tests in one file).
function reset() {
  cancelPending(T0);
}

test("request → hasPending → confirm runs execute once and clears", async () => {
  reset();
  let runs = 0;
  const { pendingId, description, nonce } = requestConfirm(
    {
      kind: "email.send",
      description: "send the draft to Vidi",
      execute: async () => {
        runs++;
        return "Sent.";
      },
    },
    { now: T0 }
  );

  assert.equal(description, "send the draft to Vidi");
  assert.match(pendingId, /^pending-/);
  assert.equal(hasPending(T0), true);
  assert.equal(pendingDescription(T0), "send the draft to Vidi");

  const res = await confirmPending(T0, { nonce });
  assert.equal(res.ran, true);
  assert.equal(res.text, "Sent.");
  assert.equal(runs, 1);

  // Cleared: nothing pending, and a second confirm is a no-op (see below).
  assert.equal(hasPending(T0), false);
  assert.equal(pendingDescription(T0), null);
});

test("double-confirm: the second confirm is a no-op and does not re-run execute", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "do a thing", execute: async () => {
      runs++;
      return "did it";
    } },
    { now: T0 }
  );

  const first = await confirmPending(T0, { nonce });
  assert.equal(first.ran, true);
  assert.equal(first.text, "did it");

  const second = await confirmPending(T0, { nonce });
  assert.equal(second.ran, false);
  assert.equal(second.text, "Nothing is waiting on you.");
  assert.equal(runs, 1); // execute fired exactly once
});

test("expiry after TTL: hasPending is false and confirm is a no-op that never runs execute", async () => {
  reset();
  let runs = 0;
  requestConfirm(
    { kind: "k", description: "expiring action", execute: async () => {
      runs++;
      return "ran";
    } },
    { now: T0, ttlMs: 120_000 }
  );

  // Just inside the TTL: still live.
  assert.equal(hasPending(T0 + 120_000), true);

  // One ms past the TTL: dead everywhere.
  const later = T0 + 120_001;
  assert.equal(hasPending(later), false);
  assert.equal(pendingDescription(later), null);

  const res = await confirmPending(later);
  assert.equal(res.ran, false);
  assert.equal(res.text, "Nothing is waiting on you.");
  assert.equal(runs, 0); // expired action must never fire
});

test("cancel clears a live pending so confirm afterward is a no-op", async () => {
  reset();
  let runs = 0;
  requestConfirm(
    { kind: "k", description: "cancel me", execute: async () => {
      runs++;
      return "ran";
    } },
    { now: T0 }
  );
  assert.equal(hasPending(T0), true);

  const c = cancelPending(T0);
  assert.equal(c.cancelled, true);

  assert.equal(hasPending(T0), false);
  const res = await confirmPending(T0);
  assert.equal(res.ran, false);
  assert.equal(runs, 0);
});

test("cancel with nothing pending reports cancelled:false", () => {
  reset();
  const c = cancelPending(T0);
  assert.equal(c.cancelled, false);
  assert.equal(c.text, "There was nothing to cancel.");
});

test("depth 1: a new request replaces the prior one; only the newest can run", async () => {
  reset();
  let firstRuns = 0;
  let secondRuns = 0;
  requestConfirm(
    { kind: "k", description: "first", execute: async () => {
      firstRuns++;
      return "first ran";
    } },
    { now: T0 }
  );
  const { nonce: secondNonce } = requestConfirm(
    { kind: "k", description: "second", execute: async () => {
      secondRuns++;
      return "second ran";
    } },
    { now: T0 + 1 }
  );

  assert.equal(pendingDescription(T0 + 1), "second");

  const res = await confirmPending(T0 + 1, { nonce: secondNonce });
  assert.equal(res.ran, true);
  assert.equal(res.text, "second ran");
  assert.equal(firstRuns, 0); // the superseded action never fires
  assert.equal(secondRuns, 1);
});

test("a new request replaces an EXPIRED prior one", async () => {
  reset();
  let staleRuns = 0;
  let freshRuns = 0;
  requestConfirm(
    { kind: "k", description: "stale", execute: async () => {
      staleRuns++;
      return "stale ran";
    } },
    { now: T0, ttlMs: 120_000 }
  );

  // Long after the first expired, a new one arrives on a fresh clock.
  const t1 = T0 + 500_000;
  const { nonce } = requestConfirm(
    { kind: "k", description: "fresh", execute: async () => {
      freshRuns++;
      return "fresh ran";
    } },
    { now: t1 }
  );

  assert.equal(hasPending(t1), true);
  const res = await confirmPending(t1, { nonce });
  assert.equal(res.text, "fresh ran");
  assert.equal(staleRuns, 0);
  assert.equal(freshRuns, 1);
});

test("execute that throws is reported calmly, not surfaced, and still clears the slot", async () => {
  reset();
  const { nonce } = requestConfirm(
    { kind: "k", description: "boom", execute: async () => {
      throw new Error("boom");
    } },
    { now: T0 }
  );

  const res = await confirmPending(T0, { nonce });
  assert.equal(res.ran, true);
  assert.equal(res.text, "I tried, but that didn't go through.");
  // Slot cleared even though execute threw.
  assert.equal(hasPending(T0), false);
});

test("empty string result from execute falls back to a spoken 'Done.'", async () => {
  reset();
  const { nonce } = requestConfirm(
    { kind: "k", description: "quiet success", execute: async () => "" },
    { now: T0 }
  );
  const res = await confirmPending(T0, { nonce });
  assert.equal(res.ran, true);
  assert.equal(res.text, "Done.");
});
