import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for the memory ownership routes, mirroring
 * write-auth-gate.test.ts. The route handlers use "@/" alias imports node --test
 * can't resolve, so we exercise the exact first-line gate each route runs:
 *   - the WRITE routes (POST /api/memory/forget, /correct, /reset) call
 *     requireWriteAuth → {session, control} only (a read-only phone token is
 *     rejected — these mutate the primary memory store);
 *   - the READ routes (GET /api/memory, GET /api/memory/export) call
 *     requireReadAuth → {session, control, phone}.
 * Both must reject the forged-loopback-Host + no-Origin raw-TCP tailnet request
 * that defeats sameOriginOk() alone.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-mem-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth, requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function reqFor(method: string, p: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:4183${p}`, { method, headers });
}

const WRITE_ROUTES = [
  { name: "POST /api/memory/forget", method: "POST", path: "/api/memory/forget" },
  { name: "POST /api/memory/correct", method: "POST", path: "/api/memory/correct" },
  { name: "POST /api/memory/reset", method: "POST", path: "/api/memory/reset" },
];

for (const route of WRITE_ROUTES) {
  test(`${route.name}: tokenless request → 401`, () => {
    const r = requireWriteAuth(reqFor(route.method, route.path));
    assert.ok(r && r.status === 401);
  });
  test(`${route.name}: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401`, () => {
    const r = requireWriteAuth(reqFor(route.method, route.path, { host: "127.0.0.1:4183" }));
    assert.ok(r && r.status === 401);
  });
  test(`${route.name}: valid session token → pass`, () => {
    assert.equal(requireWriteAuth(reqFor(route.method, route.path, { "x-vidi-session-token": SESSION })), null);
  });
  test(`${route.name}: valid control token → pass`, () => {
    assert.equal(requireWriteAuth(reqFor(route.method, route.path, { "x-vidi-control-token": CONTROL })), null);
  });
  test(`${route.name}: phone token → STILL 401 (read-only grant must not reach write routes)`, () => {
    const r = requireWriteAuth(reqFor(route.method, route.path, { "x-vidi-phone-token": PHONE }));
    assert.ok(r && r.status === 401);
  });
}

const READ_ROUTES = [
  { name: "GET /api/memory", method: "GET", path: "/api/memory" },
  { name: "GET /api/memory/export", method: "GET", path: "/api/memory/export" },
];

for (const route of READ_ROUTES) {
  test(`${route.name}: tokenless request → 401`, () => {
    const r = requireReadAuth(reqFor(route.method, route.path));
    assert.ok(r && r.status === 401);
  });
  test(`${route.name}: forged loopback Host + no Origin → STILL 401`, () => {
    const r = requireReadAuth(reqFor(route.method, route.path, { host: "127.0.0.1:4183" }));
    assert.ok(r && r.status === 401);
  });
  test(`${route.name}: valid session token → pass`, () => {
    assert.equal(requireReadAuth(reqFor(route.method, route.path, { "x-vidi-session-token": SESSION })), null);
  });
  test(`${route.name}: phone token → pass (read surface admits the phone)`, () => {
    assert.equal(requireReadAuth(reqFor(route.method, route.path, { "x-vidi-phone-token": PHONE })), null);
  });
}
