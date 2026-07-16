import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth-gate contract for /api/update/{check,status,apply}, mirroring
 * journey-route-auth.test.ts. The route handlers use "@/" alias imports
 * node --test can't resolve, so we exercise the exact first-line gate each
 * method runs:
 *   - GET  /api/update/check   → requireReadAuth  ({session, control, phone})
 *   - GET  /api/update/status  → requireReadAuth  ({session, control, phone})
 *   - POST /api/update/apply   → requireWriteAuth ({session, control} only —
 *     the read-only phone token must NOT be able to trigger a code-replacing
 *     over-the-air update).
 * Both must reject the forged-loopback-Host + no-Origin raw-TCP tailnet request
 * that defeats sameOriginOk() alone.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-update-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth, requireReadAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

function reqFor(url: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:4183${url}`, { method, headers });
}

// ── GET /api/update/check + /status — read gate ─────────────────────────────
for (const url of ["/api/update/check", "/api/update/status"]) {
  test(`GET ${url}: tokenless request → 401`, () => {
    const r = requireReadAuth(reqFor(url, "GET"));
    assert.ok(r && r.status === 401);
  });

  test(`GET ${url}: forged loopback Host + no Origin → STILL 401`, () => {
    const r = requireReadAuth(reqFor(url, "GET", { host: "127.0.0.1:4183" }));
    assert.ok(r && r.status === 401);
  });

  test(`GET ${url}: valid session token → pass`, () => {
    assert.equal(requireReadAuth(reqFor(url, "GET", { "x-vidi-session-token": SESSION })), null);
  });

  test(`GET ${url}: phone token → pass (read surface admits the phone)`, () => {
    assert.equal(requireReadAuth(reqFor(url, "GET", { "x-vidi-phone-token": PHONE })), null);
  });
}

// ── POST /api/update/apply — write gate ─────────────────────────────────────
test("POST /api/update/apply: tokenless request → 401", () => {
  const r = requireWriteAuth(reqFor("/api/update/apply", "POST"));
  assert.ok(r && r.status === 401);
});

test("POST /api/update/apply: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401", () => {
  const r = requireWriteAuth(reqFor("/api/update/apply", "POST", { host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401);
});

test("POST /api/update/apply: valid session token → pass", () => {
  assert.equal(
    requireWriteAuth(reqFor("/api/update/apply", "POST", { "x-vidi-session-token": SESSION })),
    null,
  );
});

test("POST /api/update/apply: valid control token → pass", () => {
  assert.equal(
    requireWriteAuth(reqFor("/api/update/apply", "POST", { "x-vidi-control-token": CONTROL })),
    null,
  );
});

test("POST /api/update/apply: phone token → STILL 401 (read-only grant cannot trigger an update)", () => {
  const r = requireWriteAuth(reqFor("/api/update/apply", "POST", { "x-vidi-phone-token": PHONE }));
  assert.ok(r && r.status === 401);
});
