import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * POST /api/phone/browser-session (2026-07-10, owner-approved elevation of
 * the phone token's scope — see THREAT_MODEL.md "B7"). The route's top-level
 * imports are relative (not "@/"), same pattern as
 * app/api/phone/ask/route.ts, so unlike most app/api routes it — not just the
 * lib functions it calls — can be imported and its exported handler called
 * directly under plain `node --test`: a real integration test of the actual
 * runtime handler.
 *
 * data/ round-trips need an isolated cwd (same pattern as phone-token.test.ts
 * and phone-browser-pairing.test.ts) — chdir BEFORE importing anything that
 * touches data/.
 */
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-phone-browser-session-test-")));

const { getPhoneToken } = await import("../lib/phone-token.ts");
const { PHONE_BROWSER_COOKIE_NAME, verifyPhoneBrowserCookieValue, buildPhoneBrowserCookieHeader } =
  await import("../lib/phone-browser-pairing.ts");
const routeModule = await import("../app/api/phone/browser-session/route.ts");

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/phone/browser-session", {
    method: "POST",
    headers: headers ?? {},
  });
}

test("valid phone token -> 204 with a Set-Cookie byte-identical to /pair's cookie", async () => {
  const token = getPhoneToken();
  const response = await routeModule.POST(makeRequest({ "x-vidi-phone-token": token }));
  assert.equal(response.status, 204);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header");

  // Byte-for-byte identical to buildPhoneBrowserCookieHeader() — the SAME
  // helper /pair/route.ts calls — proving this route reuses it rather than a
  // hand-rolled copy that could drift.
  assert.equal(setCookie, buildPhoneBrowserCookieHeader());

  assert.match(setCookie!, new RegExp(`^${PHONE_BROWSER_COOKIE_NAME}=`));
  assert.match(setCookie!, /Path=\//);
  assert.match(setCookie!, /HttpOnly/);
  assert.match(setCookie!, /Secure/);
  assert.match(setCookie!, /SameSite=Lax/);
  assert.match(setCookie!, /Max-Age=31536000/); // 365 days, in seconds

  const value = setCookie!.split(";")[0].split("=")[1];
  assert.equal(verifyPhoneBrowserCookieValue(value), true);

  // No body: nothing echoed back on success.
  assert.equal(await response.text(), "");
});

test("bad token -> 401, no cookie set, no body echo", async () => {
  const response = await routeModule.POST(makeRequest({ "x-vidi-phone-token": "wrong" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.equal(body.error, "invalid or missing phone token");
});

test("absent token -> 401, no cookie set", async () => {
  const response = await routeModule.POST(makeRequest());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("each call re-verifies: a stale/rotated token stops minting the cookie", async () => {
  const token = getPhoneToken();
  assert.equal((await routeModule.POST(makeRequest({ "x-vidi-phone-token": token }))).status, 204);
  // Simulate rotation by corrupting the on-disk token file directly (no public
  // "rotate" API exists; this proves the route re-verifies every call, not a
  // memoized "authorized once" flag).
  fs.writeFileSync(path.join(process.cwd(), "data", "phone-token"), "rotated-away\n", { mode: 0o600 });
  assert.equal((await routeModule.POST(makeRequest({ "x-vidi-phone-token": token }))).status, 401);
});

test("no GET handler is exported (Next.js's framework default 405s a GET with an Allow header at the HTTP layer; that layer is out of scope for a direct handler-import test like this one — verified live with curl against a real dev server, see PR body)", () => {
  assert.equal((routeModule as { GET?: unknown }).GET, undefined);
});
