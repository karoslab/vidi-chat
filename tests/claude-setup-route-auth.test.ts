import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for the new privileged Connect Claude routes (Phase A of
 * the Helper demotion), mirroring journey-route-auth.test.ts. The route handlers
 * use "@/" alias imports node --test can't resolve, so we exercise the exact
 * first-line gate each method runs:
 *   - POST /api/setup/claude/install → requireWriteAuth ({session, control})
 *     — it launches a privileged install.
 *   - GET  /api/setup/claude/install → requireReadAuth ({session, control, phone})
 *     — a status poll, part of the read surface.
 *   - POST /api/setup/claude/login   → requireWriteAuth ({session, control})
 *     — it spawns the sign-in.
 * All must reject the forged-loopback-Host + no-Origin raw-TCP tailnet request
 * that defeats sameOriginOk() alone, and a read-only phone token must never
 * reach either write route.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-route-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth, requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function reqFor(url: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

const INSTALL = "http://127.0.0.1:4183/api/setup/claude/install";
const LOGIN = "http://127.0.0.1:4183/api/setup/claude/login";

// ── POST /api/setup/claude/install — write gate ──────────────────────────────
test("POST install: tokenless → 401", () => {
  const r = requireWriteAuth(reqFor(INSTALL, "POST"));
  assert.ok(r && r.status === 401);
});

test("POST install: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401", () => {
  const r = requireWriteAuth(reqFor(INSTALL, "POST", { host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401);
});

test("POST install: session token → pass", () => {
  assert.equal(requireWriteAuth(reqFor(INSTALL, "POST", { "x-vidi-session-token": SESSION })), null);
});

test("POST install: control token → pass", () => {
  assert.equal(requireWriteAuth(reqFor(INSTALL, "POST", { "x-vidi-control-token": CONTROL })), null);
});

test("POST install: phone token → STILL 401 (read-only grant must not launch an install)", () => {
  const r = requireWriteAuth(reqFor(INSTALL, "POST", { "x-vidi-phone-token": PHONE }));
  assert.ok(r && r.status === 401);
});

// ── GET /api/setup/claude/install — read gate ────────────────────────────────
test("GET install status: tokenless → 401", () => {
  const r = requireReadAuth(reqFor(INSTALL, "GET"));
  assert.ok(r && r.status === 401);
});

test("GET install status: session token → pass", () => {
  assert.equal(requireReadAuth(reqFor(INSTALL, "GET", { "x-vidi-session-token": SESSION })), null);
});

test("GET install status: phone token → pass (status poll is read surface)", () => {
  assert.equal(requireReadAuth(reqFor(INSTALL, "GET", { "x-vidi-phone-token": PHONE })), null);
});

// ── POST /api/setup/claude/login — write gate ────────────────────────────────
test("POST login: tokenless → 401", () => {
  const r = requireWriteAuth(reqFor(LOGIN, "POST"));
  assert.ok(r && r.status === 401);
});

test("POST login: session token → pass", () => {
  assert.equal(requireWriteAuth(reqFor(LOGIN, "POST", { "x-vidi-session-token": SESSION })), null);
});

test("POST login: phone token → STILL 401 (read-only grant must not spawn sign-in)", () => {
  const r = requireWriteAuth(reqFor(LOGIN, "POST", { "x-vidi-phone-token": PHONE }));
  assert.ok(r && r.status === 401);
});
