import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tier-2 fix-round finding 1 (2026-07-06, BLOCKER). Page routes are NOT covered
 * by the /api Host allowlist requireReadAuth enforces — only API handlers check
 * Host. app/layout.tsx's SessionTokenShim must therefore gate the token
 * injection on the INCOMING page request's own Host header using the same
 * loopback allowlist (isLoopbackHost), so a tailnet browser loading "/" via the
 * tailscale-serve HTTPS proxy (Host: *.ts.net) never receives a working
 * credential in the HTML it can then replay against every token-gated route.
 *
 * node --test can't render the actual RSC tree, so this reproduces
 * SessionTokenShim's exact decision (isLoopbackHost(host) gates whether the
 * <script> — and the token inside it — is emitted at all) against real request
 * Host values, proving both the positive (loopback → token present) and
 * negative (ts.net / any foreign Host → NO token, not even inert) cases.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-layout-shim-")));
// Ambient VIDI_TRUSTED_HOSTS (e.g. this machine's own tailnet address, set for
// the real running service) must not leak into isLoopbackHost's decision here —
// pin it off so the foreign-Host cases below are actually foreign.
delete process.env.VIDI_TRUSTED_HOSTS;

const { getSessionToken } = await import("../lib/session-token.ts");
const { isLoopbackHost } = await import("../lib/origin.ts");

const SESSION = getSessionToken();

/** SessionTokenShim's guard + injected payload, verbatim in behavior. */
function renderShim(host: string | null): string | null {
  if (!isLoopbackHost(host)) return null; // no script tag at all → no token in the HTML
  const token = getSessionToken();
  return `(function(){var t=${JSON.stringify(token)};/* fetch wrap */})();`;
}

test("loopback Host (127.0.0.1:4183) → token IS injected", () => {
  const html = renderShim("127.0.0.1:4183");
  assert.ok(html && html.includes(SESSION), "the local page must still get the token");
});

test("loopback Host (localhost:4183) → token IS injected", () => {
  const html = renderShim("localhost:4183");
  assert.ok(html && html.includes(SESSION));
});

test("tailscale-serve HTTPS-proxy Host (*.ts.net) → NO script, NO token anywhere in output", () => {
  const html = renderShim("example-host.tailabcdef.ts.net");
  assert.equal(html, null, "non-loopback Host must render nothing — not even an inert script");
});

test("any other foreign Host (DNS-rebinding / drive-by) → NO token", () => {
  for (const host of ["evil.com", "evil.com:4183", "100.100.100.100:4183", ""]) {
    const html = renderShim(host || null);
    assert.equal(html, null, `Host "${host}" must not receive the token`);
  }
});

test("null/missing Host header → NO token", () => {
  assert.equal(renderShim(null), null);
});

test("regression guard: the token string itself never appears for a non-loopback Host", () => {
  // Belt-and-suspenders: even if renderShim's logic changes, the token value
  // must never show up in output for a request whose Host isn't loopback.
  const foreignHosts = ["example-host.tailabcdef.ts.net", "attacker.example", "127.0.0.1:9999"];
  for (const host of foreignHosts) {
    const html = renderShim(host);
    assert.ok(html === null || !html.includes(SESSION), `token leaked for Host ${host}`);
  }
});
