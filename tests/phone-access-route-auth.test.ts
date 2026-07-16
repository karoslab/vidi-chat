import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for the phone-access routes, mirroring
 * journey-route-auth.test.ts (the "@/" alias route handlers aren't resolvable
 * under plain node --test, so we exercise the exact first-line gate each runs):
 *   - GET  /api/phone-access/status    → requireReadAuth  → {session, control, phone}
 *   - POST /api/phone-access/mint-code → requireWriteAuth → {session, control} ONLY.
 *     The phone token MUST NOT reach mint-code: a device that only holds the
 *     phone token cannot self-mint fresh pairing codes (B7 amendment). The
 *     forged-loopback-Host + no-Origin raw-TCP tailnet request that defeats
 *     sameOriginOk() alone must still 401 on both.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-phone-access-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth, requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function req(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4183/api/phone-access", { method, headers });
}

// ── GET /api/phone-access/status — read gate ─────────────────────────────────
test("status GET: tokenless → 401", () => {
  assert.equal(requireReadAuth(req("GET"))?.status, 401);
});
test("status GET: forged loopback Host + no Origin → STILL 401", () => {
  assert.equal(requireReadAuth(req("GET", { host: "127.0.0.1:4183" }))?.status, 401);
});
test("status GET: session token → pass", () => {
  assert.equal(requireReadAuth(req("GET", { "x-vidi-session-token": SESSION })), null);
});
test("status GET: control token → pass", () => {
  assert.equal(requireReadAuth(req("GET", { "x-vidi-control-token": CONTROL })), null);
});
test("status GET: phone token → pass (read surface admits the phone)", () => {
  assert.equal(requireReadAuth(req("GET", { "x-vidi-phone-token": PHONE })), null);
});

// ── POST /api/phone-access/mint-code — write gate ────────────────────────────
test("mint-code POST: tokenless → 401", () => {
  assert.equal(requireWriteAuth(req("POST"))?.status, 401);
});
test("mint-code POST: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401", () => {
  assert.equal(requireWriteAuth(req("POST", { host: "127.0.0.1:4183" }))?.status, 401);
});
test("mint-code POST: session token → pass (already holds full read+write, mints no new privilege)", () => {
  assert.equal(requireWriteAuth(req("POST", { "x-vidi-session-token": SESSION })), null);
});
test("mint-code POST: control token → pass", () => {
  assert.equal(requireWriteAuth(req("POST", { "x-vidi-control-token": CONTROL })), null);
});
test("mint-code POST: phone token → STILL 401 (a phone must NOT self-mint pairing codes)", () => {
  assert.equal(requireWriteAuth(req("POST", { "x-vidi-phone-token": PHONE }))?.status, 401);
});
