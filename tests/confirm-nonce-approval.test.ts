import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P1 (B1, Layer A) — the per-command approval nonce.
 *
 * Approving a parked action now requires presenting THAT action's random nonce
 * (minted by fileConfirm/requestConfirm, machine-carried by the Swift overlay).
 * This is the half of B1 that closes the "confirm is a fixed guessable string"
 * forge: a blind approval with no/wrong nonce must not run the action, and — so
 * an attacker can't burn a pending slot the real UI could still approve — a
 * wrong-nonce attempt must NOT clear the slot.
 *
 * Isolate cwd before importing so the pending file lands in a temp dir (same
 * pattern as confirm.test.ts).
 */
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-nonce-test-")));
const { fileConfirm, requestConfirm, hasPending, confirmPending, cancelPending } =
  await import("../lib/confirm.ts");

const T0 = 1_000_000_000_000;
function reset() {
  cancelPending(T0);
}

test("fileConfirm mints a nonce and returns it", () => {
  reset();
  const { nonce } = fileConfirm(
    { kind: "k", payload: {}, description: "do a thing" },
    { now: T0 }
  );
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length >= 16, "nonce is long enough to be unguessable");
  reset();
});

test("two filings get DIFFERENT nonces (per-command, not fixed)", () => {
  reset();
  const a = fileConfirm({ kind: "k", payload: {}, description: "a" }, { now: T0 }).nonce;
  const b = fileConfirm({ kind: "k", payload: {}, description: "b" }, { now: T0 + 1 }).nonce;
  assert.notEqual(a, b);
  reset();
});

test("approval with the WRONG nonce does not run and does NOT clear the slot", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "ran"; } },
    { now: T0 }
  );

  const bad = await confirmPending(T0, { nonce: nonce + "x" });
  assert.equal(bad.ran, false, "a wrong nonce must not run the action");
  assert.equal(runs, 0);
  // The slot survives a bad guess — the legitimate approval can still land.
  assert.equal(hasPending(T0), true, "a wrong-nonce attempt must not burn the slot");

  const good = await confirmPending(T0, { nonce });
  assert.equal(good.ran, true);
  assert.equal(good.text, "ran");
  assert.equal(runs, 1);
});

test("approval with NO nonce is rejected even though something is pending", async () => {
  reset();
  let runs = 0;
  requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "ran"; } },
    { now: T0 }
  );
  const res = await confirmPending(T0);
  assert.equal(res.ran, false, "a nonce-less approval must be refused");
  assert.equal(res.text, "Nothing is waiting on you.", "leaks no oracle about the parked action");
  assert.equal(runs, 0);
  assert.equal(hasPending(T0), true, "the slot is untouched by the refusal");
  reset();
});
