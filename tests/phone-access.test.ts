import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Stage 6 "Vidi on your phone" — the readiness model, the journey verify() truth
 * table, and a mechanical no-dash / no-jargon scan.
 *
 * All Tailscale interaction goes through a FAKE `tailscale` (TAILSCALE_BIN, the
 * same override pattern as GH_BIN in lib/github-connect.ts) driven by FAKE_TS_*
 * env vars, so no real tailnet or account is touched. The pairing witness is a
 * real file under a temp cwd data dir.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-phone-access-"));
process.chdir(tmp); // dataPath() → <cwd>/data under the test sentinel

const FAKE_TS = path.join(tmp, "tailscale");
fs.writeFileSync(
  FAKE_TS,
  `#!/bin/sh
sub="$1 $2"
case "$sub" in
  "status --json")
    if [ "$FAKE_TS_LOGGED_IN" = "1" ]; then
      printf '{"BackendState":"Running","Self":{"DNSName":"example-host.tailabcdef.ts.net.","HostName":"example-host"}}'
    else
      printf '{"BackendState":"NeedsLogin","Self":{}}'
    fi ;;
  "serve status")
    if [ "$FAKE_TS_SERVE" = "1" ]; then
      printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"example-host.tailabcdef.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "\${FAKE_TS_PORT:-4183}"
    else
      printf '{}'
    fi ;;
  *) echo "unexpected: $@" 1>&2; exit 3 ;;
esac
exit 0
`,
  { mode: 0o755 }
);

const DEVICE = "example-host.tailabcdef.ts.net";
process.env.TAILSCALE_BIN = FAKE_TS;
process.env.VIDI_PORT = "4188";
process.env.FAKE_TS_PORT = "4188";

const { readiness, trustedHostSetFor, localPort } = await import("../lib/phone-access.ts");
const { phoneAccessStep, PHONE_ACCESS_STEP_ID } = await import("../lib/journey/steps/phone-access.ts");
const { markPairingConsumed } = await import("../lib/phone-browser-pairing.ts");

function resetEnv() {
  delete process.env.FAKE_TS_LOGGED_IN;
  delete process.env.FAKE_TS_SERVE;
  delete process.env.VIDI_TRUSTED_HOSTS;
  process.env.TAILSCALE_BIN = FAKE_TS;
}
function clearPairingWitness() {
  try {
    fs.unlinkSync(path.join(tmp, "data", "phone-pairing-last"));
  } catch {
    /* already absent */
  }
}

// ── readiness model ──────────────────────────────────────────────────────────
test("readiness: Tailscale not installed → everything false", async () => {
  resetEnv();
  process.env.TAILSCALE_BIN = path.join(tmp, "does-not-exist");
  const r = await readiness();
  assert.deepEqual(r, {
    tailscaleInstalled: false,
    loggedIn: false,
    deviceName: null,
    serveActive: false,
    trustedHostSet: false,
  });
});

test("readiness: installed but signed out → installed true, rest false", async () => {
  resetEnv();
  const r = await readiness();
  assert.equal(r.tailscaleInstalled, true);
  assert.equal(r.loggedIn, false);
  assert.equal(r.deviceName, null);
  assert.equal(r.serveActive, false);
  assert.equal(r.trustedHostSet, false);
});

test("readiness: signed in, connection off, not trusted → deviceName parsed (no trailing dot)", async () => {
  resetEnv();
  process.env.FAKE_TS_LOGGED_IN = "1";
  const r = await readiness();
  assert.equal(r.loggedIn, true);
  assert.equal(r.deviceName, DEVICE);
  assert.equal(r.serveActive, false);
  assert.equal(r.trustedHostSet, false);
});

test("readiness: signed in + serve on for OUR port + trusted host set → all true", async () => {
  resetEnv();
  process.env.FAKE_TS_LOGGED_IN = "1";
  process.env.FAKE_TS_SERVE = "1";
  process.env.VIDI_TRUSTED_HOSTS = DEVICE;
  const r = await readiness();
  assert.equal(r.serveActive, true);
  assert.equal(r.trustedHostSet, true);
});

test("readiness: serve forwarding a DIFFERENT port does not count as active", async () => {
  resetEnv();
  process.env.FAKE_TS_LOGGED_IN = "1";
  process.env.FAKE_TS_SERVE = "1";
  process.env.FAKE_TS_PORT = "9999"; // not our localPort()
  const r = await readiness();
  assert.equal(r.serveActive, false);
  process.env.FAKE_TS_PORT = "4188";
});

test("trustedHostSetFor: exact membership only, null device is never trusted", () => {
  process.env.VIDI_TRUSTED_HOSTS = `other.ts.net, ${DEVICE} `;
  assert.equal(trustedHostSetFor(DEVICE), true);
  assert.equal(trustedHostSetFor("nope.ts.net"), false);
  assert.equal(trustedHostSetFor(null), false);
  assert.equal(localPort(), "4188");
});

// ── verify() truth table ─────────────────────────────────────────────────────
test("step metadata: stage 6, skippable, stable id", () => {
  assert.equal(phoneAccessStep.stage, 6);
  assert.equal(phoneAccessStep.skippable, true);
  assert.equal(phoneAccessStep.id, PHONE_ACCESS_STEP_ID);
});

test("verify: not installed → ok:false, points back at this step, no dashes", async () => {
  resetEnv();
  process.env.TAILSCALE_BIN = path.join(tmp, "does-not-exist");
  const r = await phoneAccessStep.verify();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.fixStepId, PHONE_ACCESS_STEP_ID);
    assert.doesNotMatch(r.reason, /[—–]/);
  }
});

test("verify: signed in but connection off → ok:false (not turned on)", async () => {
  resetEnv();
  process.env.FAKE_TS_LOGGED_IN = "1";
  const r = await phoneAccessStep.verify();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /turned on|Enable phone access/i);
});

test("verify: connection on + trusted but NO phone has paired → ok:false", async () => {
  resetEnv();
  clearPairingWitness();
  process.env.FAKE_TS_LOGGED_IN = "1";
  process.env.FAKE_TS_SERVE = "1";
  process.env.VIDI_TRUSTED_HOSTS = DEVICE;
  const r = await phoneAccessStep.verify();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /type the code|on your phone/i);
});

test("verify: connection on + trusted + a phone actually paired → ok:true", async () => {
  resetEnv();
  process.env.FAKE_TS_LOGGED_IN = "1";
  process.env.FAKE_TS_SERVE = "1";
  process.env.VIDI_TRUSTED_HOSTS = DEVICE;
  markPairingConsumed(); // witness written to <cwd>/data/phone-pairing-last
  const r = await phoneAccessStep.verify();
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.note || "", /phone/i);
});

// ── mechanical copy guards ───────────────────────────────────────────────────
const OWNED_FILES = [
  "lib/phone-access.ts",
  "lib/journey/steps/phone-access.ts",
  "app/api/phone-access/status/route.ts",
  "app/api/phone-access/mint-code/route.ts",
  "components/journey/steps/PhoneAccess.tsx",
];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("Stage 6 owned files carry no em/en dashes outside comments", () => {
  const root = new URL("../", import.meta.url);
  for (const rel of OWNED_FILES) {
    const code = stripComments(fs.readFileSync(new URL(rel, root), "utf8"));
    const hit = /[—–]/.exec(code);
    const ctx = hit ? code.slice(Math.max(0, hit.index - 40), hit.index + 40) : "";
    assert.equal(hit, null, `${rel} has an em/en dash outside a comment near: ${ctx}`);
  }
});

test("customer-facing UI + step copy never leaks the jargon words", () => {
  const root = new URL("../", import.meta.url);
  // Only the surfaces a customer reads: the step reasons/notes and the screen.
  const UI_FILES = ["lib/journey/steps/phone-access.ts", "components/journey/steps/PhoneAccess.tsx"];
  for (const rel of UI_FILES) {
    const code = stripComments(fs.readFileSync(new URL(rel, root), "utf8"));
    assert.doesNotMatch(code, /tailnet|magicdns|ts\.net|tailscale serve/i, `${rel} leaks jargon`);
  }
});
