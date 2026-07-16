import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * B1 nonce DELIVERY (the app-facing half of PR #25's gate): the trusted UI can
 * only carry back the per-command nonce if the server hands it out — and only to
 * a control-authorized caller. This pins `pendingApproval()` (the getter the
 * voice-command route reads) and the exact gating rule the route applies:
 *   deliver iff (controlAuthorized === true) AND a live nonce'd record exists.
 * The route handler itself uses "@/" alias imports node --test won't resolve
 * (push-route.test.ts precedent), so we exercise the two load-bearing pieces the
 * route composes: pendingApproval() and verifyControlToken(req).
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-delivery-test-")));

const { fileConfirm, pendingApproval, confirmPending, registerExecutor } = await import(
  "../lib/confirm.ts"
);
const { getControlToken, verifyControlToken } = await import("../lib/control.ts");

// A no-op executor so the filed kind is runnable (mirrors a real registry kind).
registerExecutor("test-kind", async () => "did the thing");

test("pendingApproval returns null when nothing is parked", () => {
  assert.equal(pendingApproval(), null);
});

test("pendingApproval surfaces the live record's description + nonce", () => {
  const { nonce } = fileConfirm({
    kind: "test-kind",
    payload: { x: 1 },
    description: "send an email to Sam",
  });
  const pa = pendingApproval();
  assert.ok(pa, "expected a live pending approval");
  assert.equal(pa.description, "send an email to Sam");
  assert.equal(pa.nonce, nonce); // exactly the minted nonce the UI must echo
  assert.match(pa.nonce, /^[A-Za-z0-9_-]+$/); // machine-side random base64url, not user-facing
});

// The route's exact gating rule, reproduced: the nonce is delivered ONLY to a
// control-authorized request. A tokenless/blind POST must get the spoken text
// but never the nonce.
function deliveredPendingConfirm(req: Request) {
  const controlAuthorized = verifyControlToken(req);
  const pending = controlAuthorized ? pendingApproval() : null;
  return pending ? { description: pending.description, nonce: pending.nonce } : null;
}

test("nonce is delivered to a control-authorized request", () => {
  const tok = getControlToken();
  const req = new Request("http://localhost:4183/api/voice-command", {
    method: "POST",
    headers: { "x-vidi-control-token": tok },
  });
  const out = deliveredPendingConfirm(req);
  assert.ok(out);
  assert.equal(typeof out.nonce, "string");
  assert.ok(out.nonce.length > 0);
});

test("nonce is NEVER delivered to a tokenless / wrong-token request", () => {
  const noTok = new Request("http://localhost:4183/api/voice-command", { method: "POST" });
  const wrongTok = new Request("http://localhost:4183/api/voice-command", {
    method: "POST",
    headers: { "x-vidi-control-token": "not-the-token" },
  });
  assert.equal(deliveredPendingConfirm(noTok), null);
  assert.equal(deliveredPendingConfirm(wrongTok), null);
});

test("end to end: the delivered nonce is exactly what approves the action", async () => {
  // Fresh parked action.
  const { nonce } = fileConfirm({
    kind: "test-kind",
    payload: null,
    description: "delete the draft",
  });
  const delivered = pendingApproval();
  assert.equal(delivered?.nonce, nonce);

  // Wrong nonce does NOT run and does NOT burn the slot.
  const wrong = await confirmPending(Date.now(), { nonce: "deadbeef" });
  assert.equal(wrong.ran, false);
  assert.ok(pendingApproval(), "wrong nonce must not clear the pending slot");

  // The delivered nonce runs it exactly once.
  const ok = await confirmPending(Date.now(), { nonce: delivered!.nonce });
  assert.equal(ok.ran, true);
  assert.equal(ok.text, "did the thing");
  assert.equal(pendingApproval(), null); // single-shot: slot cleared
});
