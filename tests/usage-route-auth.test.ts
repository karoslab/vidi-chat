import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for GET /api/usage/retro, mirroring
 * update-route-auth.test.ts. The route handler uses "@/" alias imports
 * node --test can't resolve, so we exercise the exact first-line gate it runs:
 *   - GET /api/usage/retro → requireReadAuth ({session, control, phone})
 * It must reject the forged-loopback-Host + no-Origin raw-TCP tailnet request
 * that defeats sameOriginOk() alone. This is owner introspection of local data
 * only, so the read grant (including the phone) is the right boundary.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-usage-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

const URL = "/api/usage/retro";
function reqFor(headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:4183${URL}`, { method: "GET", headers });
}

test(`GET ${URL}: tokenless request → 401`, () => {
  const r = requireReadAuth(reqFor());
  assert.ok(r && r.status === 401);
});

test(`GET ${URL}: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401`, () => {
  const r = requireReadAuth(reqFor({ host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401);
});

test(`GET ${URL}: valid session token → pass`, () => {
  assert.equal(requireReadAuth(reqFor({ "x-vidi-session-token": SESSION })), null);
});

test(`GET ${URL}: valid control token → pass`, () => {
  assert.equal(requireReadAuth(reqFor({ "x-vidi-control-token": CONTROL })), null);
});

test(`GET ${URL}: phone token → pass (read surface admits the phone)`, () => {
  assert.equal(requireReadAuth(reqFor({ "x-vidi-phone-token": PHONE })), null);
});
