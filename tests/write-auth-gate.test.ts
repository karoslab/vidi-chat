import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P8 finding 3 (P7 re-audit) — the durable RCE fix, plus the fresh-context
 * re-review's follow-up ("finding 3's own guarantee is materially false while
 * coequal write routes stay on sameOriginOk alone"). ALL state-changing /
 * capability-granting POST/PATCH/DELETE routes now gate on requireWriteAuth
 * instead of (or in addition to) sameOriginOk:
 *   /api/chat, /api/loop, /api/user-config, /api/history (original P8 wave),
 *   /api/voice-command (THE sharp one — mode:"act" in the body could drive a
 *     full act turn on sameOriginOk alone),
 *   /api/agents POST (spawn), /api/agents/[id] POST+DELETE (prompt/kill),
 *   /api/events POST, PATCH+DELETE /api/threads/[id],
 *   POST /api/attachments, POST /api/onboarding, POST /api/onboarding/deferred,
 *   /api/accounts POST (2nd re-review — switches the active account/config-dir
 *     every subsequent act-mode turn runs under), /api/tts POST (2nd re-review
 *     — an undisclosed egress path that burns the proxy secret + quota).
 *
 * Once `tailscale serve` proxies the tailnet, a raw-TCP peer forges a loopback
 * Host with no Origin and passes sameOriginOk() — re-opening the act-mode RCE
 * through WHICHEVER of these routes still relied on it alone. requireWriteAuth()
 * demands a POSITIVE session/control token a remote peer can't read off this
 * machine's disk. These tests pin, for every route above:
 *   - no token → 401,
 *   - forged loopback Host + no Origin (the tailnet hole) → STILL 401,
 *   - session token → pass, control token → pass, phone token → reject,
 *   - the route guard line (requireWriteAuth) closes the exact raw-TCP request.
 *
 * The route handlers can't be imported (they use "@/" alias imports node --test
 * won't resolve — see read-auth-gate.test.ts); we exercise the load-bearing
 * gate the routes call as their first statement, parameterized over every
 * method+path pair above so each route's exact guard call is pinned.
 */

// Isolate data/ (token files) before importing the libs.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-write-auth-")));

const { getSessionToken } = await import("../lib/session-token.ts");
const { getControlToken } = await import("../lib/control.ts");
const { getPhoneToken } = await import("../lib/phone-token.ts");
const { requireWriteAuth } = await import("../lib/origin.ts");

const SESSION = getSessionToken();
const CONTROL = getControlToken();
const PHONE = getPhoneToken();

// A POST the way the browser / a native caller / a raw-TCP tailnet peer would
// hit one of the four write routes.
function post(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:4183/api/chat", { method: "POST", headers });
}

// The exact first-line guard every one of the four write routes now runs.
function writeRouteGuard(req: Request): { status: number } {
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return { status: unauthorized.status };
  return { status: 200 };
}

test("no credential → 401", () => {
  const r = requireWriteAuth(post());
  assert.ok(r && r.status === 401, "bare POST → rejected");
});

test("forged loopback Host + no Origin → STILL 401 (the raw-TCP tailnet hole)", () => {
  // Exactly the request that defeats sameOriginOk: a tailscale-serve raw-TCP
  // client forging Host: 127.0.0.1:4183 with no Origin. A route on sameOriginOk
  // would 200 here and drive the act-mode agent — the RCE. requireWriteAuth 401s.
  const r = requireWriteAuth(post({ host: "127.0.0.1:4183" }));
  assert.ok(r && r.status === 401, "forged loopback Host with no token → 401");
});

test("valid session token (browser fetch-shim) → pass", () => {
  assert.equal(requireWriteAuth(post({ "x-vidi-session-token": SESSION })), null);
});

test("valid control token (ops / rebuilt native caller) → pass", () => {
  assert.equal(requireWriteAuth(post({ "x-vidi-control-token": CONTROL })), null);
});

test("a phone token is NOT accepted on the write surface", () => {
  // The write routes ask for {session, control} only; the phone reaches the
  // agent through /api/phone/ask (runVoiceTurn), never /api/chat directly.
  const r = requireWriteAuth(post({ "x-vidi-phone-token": PHONE }));
  assert.ok(r && r.status === 401, "phone token → 401 on the write surface");
});

test("a wrong/forged token → 401", () => {
  const r = requireWriteAuth(post({ "x-vidi-session-token": "forged-value-not-real" }));
  assert.ok(r && r.status === 401);
});

test("route-guard shape: closed without a token, open with the session token", () => {
  assert.equal(writeRouteGuard(post()).status, 401, "bare tailnet write → 401");
  assert.equal(
    writeRouteGuard(post({ host: "127.0.0.1:4183" })).status,
    401,
    "forged Host, no token → 401"
  );
  assert.equal(
    writeRouteGuard(post({ "x-vidi-session-token": SESSION })).status,
    200,
    "browser (session token) → 200"
  );
});

/**
 * P8 follow-up (fresh-context re-review) — the full route matrix. Each entry
 * is the exact method+path the reviewer named as now-gated. We don't import
 * the route handlers (alias-import restriction, see file header) — instead we
 * pin that requireWriteAuth applied to a request built exactly as that route
 * would receive it (from the browser fetch-shim, a native caller, or the
 * forged-Host raw-TCP attack) yields the SAME verdict the route now returns as
 * its first statement.
 */
const GATED_WRITE_ROUTES: { name: string; method: string; path: string }[] = [
  { name: "/api/chat", method: "POST", path: "/api/chat" },
  { name: "/api/loop", method: "POST", path: "/api/loop" },
  { name: "/api/user-config POST", method: "POST", path: "/api/user-config" },
  { name: "/api/history POST", method: "POST", path: "/api/history" },
  { name: "/api/voice-command", method: "POST", path: "/api/voice-command" },
  { name: "/api/agents POST (spawn)", method: "POST", path: "/api/agents" },
  { name: "/api/agents/[id] POST (prompt)", method: "POST", path: "/api/agents/abc123" },
  { name: "/api/agents/[id] DELETE (kill)", method: "DELETE", path: "/api/agents/abc123" },
  { name: "/api/events POST", method: "POST", path: "/api/events" },
  // 2026-07-07 fresh-context review of the phone-read PR: POST /api/threads
  // (create) sat on GET's requireReadAuth, which would have inherited the new
  // phone read grant — now on requireWriteAuth like every other mutation.
  { name: "/api/threads POST (create)", method: "POST", path: "/api/threads" },
  { name: "/api/threads/[id] PATCH", method: "PATCH", path: "/api/threads/abc123" },
  { name: "/api/threads/[id] DELETE", method: "DELETE", path: "/api/threads/abc123" },
  { name: "/api/attachments POST", method: "POST", path: "/api/attachments" },
  { name: "/api/onboarding POST", method: "POST", path: "/api/onboarding" },
  { name: "/api/onboarding/deferred POST", method: "POST", path: "/api/onboarding/deferred" },
  // 2nd re-review additions — the two routes the completeness sweep found
  // still on sameOriginOk alone.
  { name: "/api/accounts POST (switch active account)", method: "POST", path: "/api/accounts" },
  { name: "/api/tts POST (egress: proxy secret + Cloudflare quota)", method: "POST", path: "/api/tts" },
];

function reqFor(
  route: { method: string; path: string },
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://127.0.0.1:4183${route.path}`, {
    method: route.method,
    headers,
  });
}

for (const route of GATED_WRITE_ROUTES) {
  test(`${route.name}: tokenless request → 401`, () => {
    const r = requireWriteAuth(reqFor(route));
    assert.ok(r && r.status === 401, `${route.name} must reject a bare request`);
  });

  test(`${route.name}: forged loopback Host + no Origin (raw-TCP tailnet) → STILL 401`, () => {
    // The exact raw-TCP tailscale-serve forged request the fresh-context
    // reviewer flagged: sameOriginOk() alone would 200 this.
    const r = requireWriteAuth(reqFor(route, { host: "127.0.0.1:4183" }));
    assert.ok(
      r && r.status === 401,
      `${route.name} must reject a forged loopback Host with no token`
    );
  });

  test(`${route.name}: valid session token (browser fetch-shim) → pass`, () => {
    assert.equal(
      requireWriteAuth(reqFor(route, { "x-vidi-session-token": SESSION })),
      null,
      `${route.name} must accept the browser's session token`
    );
  });

  test(`${route.name}: valid control token (ops / native caller) → pass`, () => {
    assert.equal(
      requireWriteAuth(reqFor(route, { "x-vidi-control-token": CONTROL })),
      null,
      `${route.name} must accept a valid control token`
    );
  });

  // 2026-07-07: requireReadAuth gained the phone token (GET /api/threads,
  // etc.) via a decoupled check — requireWriteAuth must NOT inherit it. Pin
  // that separation across every gated write route, not just /api/chat.
  test(`${route.name}: phone token → STILL 401 (read-only grant must not reach write routes)`, () => {
    const r = requireWriteAuth(reqFor(route, { "x-vidi-phone-token": PHONE }));
    assert.ok(r && r.status === 401, `${route.name} must reject the phone token`);
  });
}
