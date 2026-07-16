import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for /api/journey, mirroring memory-route-auth.test.ts. The
 * route handler uses "@/" alias imports node --test can't resolve, so we exercise
 * the exact first-line gate each method runs:
 *   - GET  → requireReadAuth  → {session, control, phone} (the phone can read
 *            the setup health board, same as the rest of the read surface);
 *   - POST → requireWriteAuth → {session, control} only (recheck re-runs a
 *            mechanical check; a read-only phone token must not reach it).
 * Both must reject the forged-loopback-Host + no-Origin raw-TCP tailnet request
 * that defeats sameOriginOk() alone.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-journey-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth, requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function reqFor(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4183/api/journey", { method, headers });
}

// ── GET /api/journey — read gate ────────────────────────────────────────────
test("GET /api/journey: tokenless request → 401", () => {
  const r = requireReadAuth(reqFor("GET"));
  assert.ok(r && r.status === 401);
});

test("GET /api/journey: forged loopback Host + no Origin → STILL 401", () => {
  const r = requireReadAuth(reqFor("GET", { host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401);
});

test("GET /api/journey: valid session token → pass", () => {
  assert.equal(requireReadAuth(reqFor("GET", { "x-vidi-session-token": SESSION })), null);
});

test("GET /api/journey: phone token → pass (read surface admits the phone)", () => {
  assert.equal(requireReadAuth(reqFor("GET", { "x-vidi-phone-token": PHONE })), null);
});

// ── POST /api/journey — write gate ──────────────────────────────────────────
test("POST /api/journey: tokenless request → 401", () => {
  const r = requireWriteAuth(reqFor("POST"));
  assert.ok(r && r.status === 401);
});

test("POST /api/journey: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401", () => {
  const r = requireWriteAuth(reqFor("POST", { host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401);
});

test("POST /api/journey: valid session token → pass", () => {
  assert.equal(requireWriteAuth(reqFor("POST", { "x-vidi-session-token": SESSION })), null);
});

test("POST /api/journey: valid control token → pass", () => {
  assert.equal(requireWriteAuth(reqFor("POST", { "x-vidi-control-token": CONTROL })), null);
});

test("POST /api/journey: phone token → STILL 401 (read-only grant must not reach recheck)", () => {
  const r = requireWriteAuth(reqFor("POST", { "x-vidi-phone-token": PHONE }));
  assert.ok(r && r.status === 401);
});
