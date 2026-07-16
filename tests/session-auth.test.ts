import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tier-2 auth gate. Once `tailscale serve` proxies the tailnet to this loopback
 * server, sameOriginOk() can no longer authenticate: the proxy talks to
 * 127.0.0.1 and a raw-TCP tailnet client can forge a loopback Host with no
 * Origin and pass. requireReadAuth() closes that door with a POSITIVE token —
 * the machine-local session token (browser), the control token (ops), or the
 * phone token — that a remote peer cannot obtain. These tests assert:
 *   - no token → 401,
 *   - a forged loopback Host with no Origin → STILL 401 (the tailnet hole),
 *   - the session token → pass,
 *   - the control token → pass,
 *   - a wrong token → 401,
 *   - authorizedByToken respects the requested set (phone excluded by default).
 */

// Isolate data/ (token files) before importing the libs.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-session-auth-")));

const { getSessionToken, verifySessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireReadAuth, authorizedByToken } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4183/api/goals", { headers });
}

test("session token materializes, is stable, and verifies", () => {
  assert.equal(getSessionToken(), SESSION, "stable across reads");
  assert.ok(SESSION.length >= 24, "non-trivial secret");
  assert.equal(verifySessionToken(req({ "x-vidi-session-token": SESSION })), true);
  assert.equal(verifySessionToken(req()), false, "no header → false");
  assert.equal(verifySessionToken(req({ "x-vidi-session-token": "nope" })), false);
});

test("requireReadAuth: no credential → 401", () => {
  const r = requireReadAuth(req());
  assert.ok(r, "returns a Response");
  assert.equal(r!.status, 401);
});

test("requireReadAuth: forged loopback Host + no Origin → STILL 401 (tailnet hole closed)", () => {
  // This is exactly the raw-TCP tailscale-serve request that defeats
  // sameOriginOk. A read route that relied on sameOriginOk would 200 here.
  const forged = req({ host: "127.0.0.1:4183" });
  const r = requireReadAuth(forged);
  assert.ok(r && r.status === 401, "no token → rejected even with a loopback Host");
});

test("requireReadAuth: valid session token → pass (null)", () => {
  assert.equal(requireReadAuth(req({ "x-vidi-session-token": SESSION })), null);
});

test("requireReadAuth: valid control token → pass (ops readers)", () => {
  assert.equal(requireReadAuth(req({ "x-vidi-control-token": CONTROL })), null);
});

// 2026-07-07: GET /api/threads (and every other requireReadAuth route) now
// admits the phone token — the phone Shortcut reads the FULL thread list /
// read surface (one per-install secret, no per-thread scoping) with the same
// credential it already uses for /api/phone/ask. Live curl on 2026-07-06
// confirmed this 401'd before the fix.
test("requireReadAuth: valid phone token → pass (phone read surface)", () => {
  assert.equal(requireReadAuth(req({ "x-vidi-phone-token": PHONE })), null);
});

test("requireReadAuth: wrong token → 401", () => {
  const r = requireReadAuth(req({ "x-vidi-session-token": "forged-token-value" }));
  assert.ok(r && r.status === 401);
});

// The GET guard shared by goals / context-vision / journal / user-config /
// agents / threads / quota — verbatim in behavior, matching each route file.
function readRouteGuard(r: Request): { status: number } {
  const unauthorized = requireReadAuth(r);
  if (unauthorized) return { status: unauthorized.status };
  return { status: 200 };
}

test("read routes (goals/vision/journal shape): closed without a token, open with session", () => {
  assert.equal(readRouteGuard(req()).status, 401, "bare tailnet read → 401");
  assert.equal(readRouteGuard(req({ host: "127.0.0.1:4183" })).status, 401, "forged Host → 401");
  assert.equal(
    readRouteGuard(req({ "x-vidi-session-token": SESSION })).status,
    200,
    "browser (session token) → 200"
  );
});

test("authorizedByToken: phone token is NOT accepted by the read set", () => {
  // Default set is {session, control}; a phone token must not open read routes.
  assert.equal(
    authorizedByToken(req({ "x-vidi-phone-token": PHONE }), { session: true, control: true }),
    false
  );
  // But it IS accepted when a route explicitly asks for it.
  assert.equal(
    authorizedByToken(req({ "x-vidi-phone-token": PHONE }), { phone: true }),
    true
  );
});
