import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The in-browser confirm UI's three routes — GET /api/confirm/pending,
 * POST /api/confirm/approve, POST /api/confirm/reject.
 *
 * The route handlers use "@/" alias imports plain `node --test` can't resolve
 * (same constraint as confirm-request-auth.test.ts + write-auth-gate.test.ts),
 * so we drive the REAL gate primitives (sameOriginOk / requireReadAuth /
 * requireWriteAuth from lib/origin.ts) and the REAL confirm lib through each
 * route's exact guard order + body, pinning:
 *   - every route: tokenless → 401, cross-origin → 403,
 *   - approve with the right nonce fires + returns a receipt,
 *   - a wrong nonce fails closed WITHOUT burning the slot,
 *   - an expired slot fails closed,
 *   - a depth-1 plan mutation between poll and click → stale approve fails
 *     closed and the NEW action is untouched,
 *   - reject clears the slot.
 *
 * Isolate cwd before importing so token files + the pending file land in a temp
 * dir (same pattern as the sibling auth tests).
 */
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-routes-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { sameOriginOk, requireReadAuth, requireWriteAuth } = await import("../lib/origin.ts");
const { fileConfirm, requestConfirm, confirmPending, cancelPending, hasPending, pendingView } =
  await import("../lib/confirm.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const T0 = 1_000_000_000_000;
const TTL = 120_000;

function reset() {
  cancelPending(T0);
}

// A request as the browser fetch-shim / a cross-origin page / a bare caller
// would send it to one of the three routes.
function req(pathname: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:4183${pathname}`, {
    method,
    headers: { host: "127.0.0.1:4183", ...headers },
  });
}

// GET /api/confirm/pending — sameOriginOk THEN requireReadAuth (verbatim order).
function handlePending(request: Request): { status: number; pending?: unknown } {
  if (!sameOriginOk(request)) return { status: 403 };
  const unauthorized = requireReadAuth(request);
  if (unauthorized) return { status: unauthorized.status };
  return { status: 200, pending: pendingView() };
}

// POST /api/confirm/approve — sameOriginOk THEN requireWriteAuth, then confirmPending.
async function handleApprove(
  request: Request,
  body: { nonce?: string },
  now: number
): Promise<{ status: number; ran?: boolean; text?: string }> {
  if (!sameOriginOk(request)) return { status: 403 };
  const unauthorized = requireWriteAuth(request);
  if (unauthorized) return { status: unauthorized.status };
  const { ran, text } = await confirmPending(now, { nonce: body.nonce ?? "" });
  return { status: 200, ran, text };
}

// POST /api/confirm/reject — sameOriginOk THEN requireWriteAuth, then cancelPending.
function handleReject(request: Request, now: number): { status: number; cancelled?: boolean } {
  if (!sameOriginOk(request)) return { status: 403 };
  const unauthorized = requireWriteAuth(request);
  if (unauthorized) return { status: unauthorized.status };
  const { cancelled } = cancelPending(now);
  return { status: 200, cancelled };
}

const CROSS_ORIGIN = { origin: "http://evil.example" };

// ---- pending (read gate) ----
test("GET /api/confirm/pending: tokenless → 401", () => {
  assert.equal(handlePending(req("/api/confirm/pending", "GET")).status, 401);
});
test("GET /api/confirm/pending: cross-origin → 403", () => {
  assert.equal(handlePending(req("/api/confirm/pending", "GET", CROSS_ORIGIN)).status, 403);
});
test("GET /api/confirm/pending: session token → 200 and returns the live view", () => {
  reset();
  // handlePending reads pendingView() at the real Date.now() (as the route
  // does), so file at real-now for the read to be within TTL.
  fileConfirm({ kind: "gws-email", payload: {}, description: "send an email" }, { now: Date.now() });
  const res = handlePending(req("/api/confirm/pending", "GET", { "x-vidi-session-token": SESSION }));
  assert.equal(res.status, 200);
  assert.ok(res.pending, "an authed read sees the parked action");
  cancelPending(Date.now());
});

// ---- approve (write gate) ----
test("POST /api/confirm/approve: tokenless → 401", async () => {
  assert.equal((await handleApprove(req("/api/confirm/approve", "POST"), {}, T0)).status, 401);
});
test("POST /api/confirm/approve: cross-origin → 403", async () => {
  assert.equal(
    (await handleApprove(req("/api/confirm/approve", "POST", CROSS_ORIGIN), {}, T0)).status,
    403
  );
});
test("POST /api/confirm/approve: control token but NO session is accepted (write set)", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "sent"; } },
    { now: T0 }
  );
  const res = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-control-token": CONTROL }),
    { nonce },
    T0
  );
  assert.equal(res.status, 200);
  assert.equal(res.ran, true);
  assert.equal(res.text, "sent", "the receipt is the executor's returned text");
  assert.equal(runs, 1);
});
test("POST /api/confirm/approve: right nonce fires and returns a receipt", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "send it", execute: async () => { runs++; return "Email sent to A."; } },
    { now: T0 }
  );
  const res = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce },
    T0
  );
  assert.equal(res.status, 200);
  assert.equal(res.ran, true);
  assert.equal(res.text, "Email sent to A.");
  assert.equal(runs, 1);
  assert.equal(hasPending(T0), false, "a fired action clears the slot (single-use)");
});
test("POST /api/confirm/approve: WRONG nonce fails closed and does NOT burn the slot", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "ran"; } },
    { now: T0 }
  );
  const bad = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce: nonce + "x" },
    T0
  );
  assert.equal(bad.status, 200);
  assert.equal(bad.ran, false, "a wrong nonce must not run the action");
  assert.equal(runs, 0);
  assert.equal(hasPending(T0), true, "a wrong-nonce attempt must not burn the slot");
  // The legitimate approval still lands afterward.
  const good = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce },
    T0
  );
  assert.equal(good.ran, true);
  assert.equal(runs, 1);
});
test("POST /api/confirm/approve: an EXPIRED slot fails closed", async () => {
  reset();
  let runs = 0;
  const { nonce } = requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "ran"; } },
    { now: T0 }
  );
  const res = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce },
    T0 + TTL + 1
  );
  assert.equal(res.ran, false, "a right nonce past the TTL still fails closed");
  assert.equal(runs, 0);
});
test("POST /api/confirm/approve: depth-1 plan mutation → stale approve fails closed, new action untouched", async () => {
  reset();
  let ranA = 0;
  let ranB = 0;
  // Poll sees action A and reads its nonce.
  const a = requestConfirm(
    { kind: "k", description: "action A", execute: async () => { ranA++; return "A"; } },
    { now: T0 }
  );
  const staleNonce = pendingView(T0)!.nonce;
  assert.equal(staleNonce, a.nonce);
  // A plan mutation parks action B (depth 1 replaces A) before the click lands.
  const b = requestConfirm(
    { kind: "k", description: "action B", execute: async () => { ranB++; return "B"; } },
    { now: T0 + 1 }
  );
  // The click carries A's stale nonce — it must not run A (gone) or B (different nonce).
  const stale = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce: staleNonce },
    T0 + 2
  );
  assert.equal(stale.ran, false, "a stale nonce after a plan mutation fails closed");
  assert.equal(ranA, 0);
  assert.equal(ranB, 0);
  assert.equal(hasPending(T0 + 2), true, "the new action B is not burned by the stale click");
  // Approving B with ITS nonce still works.
  const good = await handleApprove(
    req("/api/confirm/approve", "POST", { "x-vidi-session-token": SESSION }),
    { nonce: b.nonce },
    T0 + 3
  );
  assert.equal(good.ran, true);
  assert.equal(ranB, 1);
});

// ---- reject (write gate) ----
test("POST /api/confirm/reject: tokenless → 401", () => {
  assert.equal(handleReject(req("/api/confirm/reject", "POST"), T0).status, 401);
});
test("POST /api/confirm/reject: cross-origin → 403", () => {
  assert.equal(handleReject(req("/api/confirm/reject", "POST", CROSS_ORIGIN), T0).status, 403);
});
test("POST /api/confirm/reject: clears the slot without running it", async () => {
  reset();
  let runs = 0;
  requestConfirm(
    { kind: "k", description: "risky", execute: async () => { runs++; return "ran"; } },
    { now: T0 }
  );
  const res = handleReject(req("/api/confirm/reject", "POST", { "x-vidi-session-token": SESSION }), T0);
  assert.equal(res.status, 200);
  assert.equal(res.cancelled, true);
  assert.equal(runs, 0, "reject never runs the action");
  assert.equal(hasPending(T0), false, "the slot is empty after reject");
});
