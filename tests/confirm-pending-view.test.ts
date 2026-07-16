import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * pendingView(now) — the browser confirm card's read of the one live parked
 * action (lib/confirm.ts). It returns the REDACTED description (never the raw
 * payload), the action kind, the absolute expiresAt (ts + ttlMs), and the
 * per-command nonce the Approve click carries back; null when nothing live is
 * waiting or the slot has expired.
 *
 * Isolate cwd before importing so the pending file lands in a temp dir (same
 * pattern as confirm-nonce-approval.test.ts).
 */
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-pending-view-")));
const { fileConfirm, cancelPending, pendingView } = await import("../lib/confirm.ts");

const T0 = 1_000_000_000_000;
const TTL = 120_000;
function reset() {
  cancelPending(T0);
}

test("pendingView is null when nothing is parked", () => {
  reset();
  assert.equal(pendingView(T0), null);
});

test("pendingView returns kind, expiresAt (ts + ttlMs), nonce, and the description", () => {
  reset();
  const { nonce } = fileConfirm(
    { kind: "gws-email", payload: { to: "a@b.com" }, description: "send an email to A" },
    { now: T0 }
  );
  const view = pendingView(T0);
  assert.ok(view, "a live parked action produces a view");
  assert.equal(view!.kind, "gws-email");
  assert.equal(view!.description, "send an email to A");
  assert.equal(view!.expiresAt, T0 + TTL, "expiresAt is ts + ttlMs");
  assert.equal(view!.nonce, nonce, "the view carries the same per-command nonce the filing minted");
  reset();
});

test("pendingView renders the description only — never the raw payload", () => {
  reset();
  fileConfirm(
    { kind: "write-file", payload: { path: "/etc/secret", body: "AKIA-super-secret" }, description: "write a file" },
    { now: T0 }
  );
  const view = pendingView(T0);
  assert.ok(view);
  // The view surface is exactly {description, nonce, kind, expiresAt} — no payload.
  assert.deepEqual(
    Object.keys(view!).sort(),
    ["description", "expiresAt", "kind", "nonce"]
  );
  assert.equal(JSON.stringify(view).includes("AKIA-super-secret"), false, "no payload leaks into the view");
  reset();
});

test("pendingView is null once the slot has expired (past ts + ttlMs)", () => {
  reset();
  fileConfirm({ kind: "hands", payload: {}, description: "click a button" }, { now: T0 });
  assert.ok(pendingView(T0 + TTL), "still live at exactly ts + ttlMs");
  assert.equal(pendingView(T0 + TTL + 1), null, "expired one ms past the TTL");
  reset();
});
