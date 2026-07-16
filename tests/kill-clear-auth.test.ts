import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — H7. /api/kill re-arm (action:"clear") requires a POSITIVE token;
 * engage (emergency stop) stays open. The route uses "@/" imports plain
 * node --test can't resolve, so we reproduce the route's exact clear-branch
 * guard with the real verifyControlToken + verifySessionToken + kill lib.
 *
 * 2026-07-10 (UI pause/resume): the clear branch now ALSO accepts the browser
 * session token, so the in-app "Resume" button (the web UI holds the session
 * token, never the control token) can re-arm — exactly requireWriteAuth's
 * {session, control} set. The control-token path is UNCHANGED and still tested
 * below; sameOriginOk (in the real route, above this branch) additionally pins
 * the browser to same-origin. We assert:
 *   - clear WITHOUT any token → 401 (kill stays engaged),
 *   - clear WITH the control token → re-arms (unchanged),
 *   - clear WITH the session token → re-arms (new UI path),
 *   - engage without any token → still works.
 */

// data/ (control-token + session-token + KILL file) needs an isolated cwd
// before the libs compute their cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-kill-auth-")));

const { verifyControlToken, getControlToken } = await import("../lib/control.ts");
const { verifySessionToken, getSessionToken } = await import("../lib/session-token.ts");
const { engageKill, clearKill, isKillEngaged } = await import("../lib/kill.ts");

const CONTROL_TOKEN = getControlToken();
const SESSION_TOKEN = getSessionToken();

function post(action: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:4183/api/kill", {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
}

// The route's clear branch, verbatim in behavior (combined {control, session}).
function clearBranch(req: Request): { status: number } {
  if (!verifyControlToken(req) && !verifySessionToken(req)) return { status: 401 };
  clearKill();
  return { status: 200 };
}

test("clear WITHOUT any token → 401 and the kill switch stays engaged", () => {
  engageKill("test");
  assert.equal(isKillEngaged(), true);
  const res = clearBranch(post("clear"));
  assert.equal(res.status, 401);
  assert.equal(isKillEngaged(), true, "an unauthed clear must not re-arm the fleet");
});

test("clear WITH the control token → re-arms (200) — unchanged path", () => {
  engageKill("test");
  const res = clearBranch(post("clear", { "x-vidi-control-token": CONTROL_TOKEN }));
  assert.equal(res.status, 200);
  assert.equal(isKillEngaged(), false, "an authed clear removes the kill switch");
});

test("clear WITH the session token → re-arms (200) — the in-app Resume path", () => {
  engageKill("test");
  const res = clearBranch(post("clear", { "x-vidi-session-token": SESSION_TOKEN }));
  assert.equal(res.status, 200);
  assert.equal(isKillEngaged(), false, "the web UI's session token can Resume");
});

test("clear WITH a WRONG session token → 401 (kill stays engaged)", () => {
  engageKill("test");
  const res = clearBranch(post("clear", { "x-vidi-session-token": "not-the-real-token" }));
  assert.equal(res.status, 401);
  assert.equal(isKillEngaged(), true, "a bogus session token must not re-arm");
  clearKill(); // cleanup
});

test("engage stays open (no token required)", () => {
  clearKill();
  // The engage branch never checks the token — a bare POST engages.
  const { killed } = engageKill("api");
  assert.equal(typeof killed, "number");
  assert.equal(isKillEngaged(), true);
  clearKill(); // cleanup
});
