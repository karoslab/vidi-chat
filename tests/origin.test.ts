import { test } from "node:test";
import assert from "node:assert/strict";
const { sameOriginOk } = await import("../lib/origin.ts");

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost:4183/api/chat", {
    method: "POST",
    headers,
  });
}

test("no Origin header (native app / curl) is allowed", () => {
  assert.equal(sameOriginOk(req({ host: "localhost:4183" })), true);
});

test("same-origin browser request is allowed", () => {
  assert.equal(
    sameOriginOk(req({ host: "localhost:4183", origin: "http://localhost:4183" })),
    true
  );
});

test("cross-origin browser request is rejected", () => {
  assert.equal(
    sameOriginOk(req({ host: "localhost:4183", origin: "https://evil.example.com" })),
    false
  );
  // A foreign page targeting the loopback port by host still carries its own Origin.
  assert.equal(
    sameOriginOk(req({ host: "localhost:4183", origin: "http://localhost:3000" })),
    false
  );
});

test("malformed Origin is rejected", () => {
  assert.equal(sameOriginOk(req({ host: "localhost:4183", origin: "not-a-url" })), false);
});

/* -------------------------------------------------------------------------- */
/* H5 — Host allowlist (DNS-rebinding F7)                                      */
/* -------------------------------------------------------------------------- */

test("127.0.0.1:4183 Host (native app) is allowed with no Origin", () => {
  assert.equal(sameOriginOk(req({ host: "127.0.0.1:4183" })), true);
});

test("foreign Host is rejected even with a matching Origin (rebinding)", () => {
  // The DNS-rebinding case: the attacker controls both headers and makes them
  // match, but the Host is not a loopback host we serve → rejected.
  assert.equal(
    sameOriginOk(req({ host: "evil.example.com", origin: "http://evil.example.com" })),
    false
  );
  assert.equal(
    sameOriginOk(req({ host: "evil.example.com:4183", origin: "http://evil.example.com:4183" })),
    false
  );
});

test("foreign Origin against a loopback Host is still rejected", () => {
  assert.equal(
    sameOriginOk(req({ host: "127.0.0.1:4183", origin: "https://evil.example.com" })),
    false
  );
});

test("absent Host is rejected", () => {
  assert.equal(sameOriginOk(req({})), false);
});

/* -------------------------------------------------------------------------- */
/* VIDI_TRUSTED_HOSTS opt-in escape hatch (owner tailnet reach)               */
/* allowedHosts() reads process.env at call time, so toggling the env var     */
/* between calls exercises both the default-off and opted-in behavior.        */

const { isLoopbackHost } = await import("../lib/origin.ts");
const TAILNET_HOST = "100.100.100.100:4183";

test("default (unset VIDI_TRUSTED_HOSTS): a tailnet host is NOT trusted", () => {
  delete process.env.VIDI_TRUSTED_HOSTS;
  assert.equal(isLoopbackHost(TAILNET_HOST), false);
  assert.equal(sameOriginOk(req({ host: TAILNET_HOST })), false);
});

test("VIDI_TRUSTED_HOSTS opts a specific tailnet host into loopback treatment", () => {
  process.env.VIDI_TRUSTED_HOSTS = `${TAILNET_HOST},example-host.tailabcdef.ts.net:4183`;
  assert.equal(isLoopbackHost(TAILNET_HOST), true);
  // no-Origin native call under the trusted host passes sameOriginOk
  assert.equal(sameOriginOk(req({ host: TAILNET_HOST })), true);
  // a host NOT in the list is still rejected even while the flag is set
  assert.equal(isLoopbackHost("10.0.0.5:4183"), false);
  // loopback still works alongside the opt-in hosts
  assert.equal(isLoopbackHost("127.0.0.1:4183"), true);
  delete process.env.VIDI_TRUSTED_HOSTS;
});

test("blank/whitespace VIDI_TRUSTED_HOSTS entries are ignored", () => {
  process.env.VIDI_TRUSTED_HOSTS = " , ,";
  assert.equal(isLoopbackHost(TAILNET_HOST), false);
  assert.equal(isLoopbackHost("127.0.0.1:4183"), true);
  delete process.env.VIDI_TRUSTED_HOSTS;
});
