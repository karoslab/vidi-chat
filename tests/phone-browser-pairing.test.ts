import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phone-browser pairing (lib/phone-browser-pairing.ts) — the load-bearing
 * pieces behind GET /pair and app/layout.tsx's cookie exception. The routes
 * themselves use "@/" alias imports that plain `node --test` won't resolve
 * (push-route.test.ts precedent), so this exercises exactly what they call:
 * mint → consume (single-use, TTL, wrong-code) and the cookie verify the
 * layout gate runs for every non-loopback page load.
 */

// data/ round-trips need an isolated cwd.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-phone-pairing-test-")));

const {
  mintPairingCode,
  consumePairingCode,
  getPhoneBrowserCookieSecret,
  verifyPhoneBrowserCookieValue,
  lastPairingConsumedAtMs,
  PAIRING_CODE_TTL_MS,
} = await import("../lib/phone-browser-pairing.ts");

const pairingCodePath = () => path.join(process.cwd(), "data", "phone-pairing-code");
const witnessPath = () => path.join(process.cwd(), "data", "phone-pairing-last");

test("mint persists a 0600 bare-token file and returns a TTL expiry", () => {
  const { code, expiresAtEpochMs } = mintPairingCode();
  assert.match(code, /^[0-9a-f]{32}$/);
  const onDisk = fs.readFileSync(pairingCodePath(), "utf8").trim();
  assert.equal(onDisk, code); // bare token, no JSON — the redactor matches file contents
  assert.equal(fs.statSync(pairingCodePath()).mode & 0o777, 0o600);
  const remainingMs = expiresAtEpochMs - Date.now();
  assert.ok(remainingMs > 0 && remainingMs <= PAIRING_CODE_TTL_MS + 1000);
});

test("consume is single-use: correct code passes once, replay fails", () => {
  const { code } = mintPairingCode();
  assert.equal(consumePairingCode(code), true);
  assert.equal(fs.existsSync(pairingCodePath()), false); // burned on success
  assert.equal(consumePairingCode(code), false); // the Safari-history replay
});

test("wrong code fails closed and does NOT burn the pending code", () => {
  const { code } = mintPairingCode();
  assert.equal(consumePairingCode("0".repeat(32)), false);
  assert.equal(consumePairingCode(""), false);
  assert.equal(consumePairingCode(null), false);
  assert.equal(consumePairingCode(code + "extra"), false); // length mismatch
  // The real link still works after all the misses.
  assert.equal(consumePairingCode(code), true);
});

test("expired code fails and is deleted on sight", () => {
  const { code } = mintPairingCode();
  const past = new Date(Date.now() - PAIRING_CODE_TTL_MS - 60_000);
  fs.utimesSync(pairingCodePath(), past, past); // backdate mtime = the expiry anchor
  assert.equal(consumePairingCode(code), false);
  assert.equal(fs.existsSync(pairingCodePath()), false);
});

test("consume with nothing pending fails closed", () => {
  assert.equal(fs.existsSync(pairingCodePath()), false);
  assert.equal(consumePairingCode("anything"), false);
});

test("a successful consume writes the (non-secret) phone-paired witness", () => {
  try {
    fs.unlinkSync(witnessPath());
  } catch {
    /* absent */
  }
  assert.equal(lastPairingConsumedAtMs(), null); // nothing paired yet
  const { code } = mintPairingCode();
  const before = Date.now();
  assert.equal(consumePairingCode(code), true);
  const at = lastPairingConsumedAtMs();
  assert.ok(at !== null && at >= before - 1000, "witness timestamp recorded on consume");
  assert.equal(fs.statSync(witnessPath()).mode & 0o777, 0o600);
  // A wrong-code miss must NOT move the witness (no false "a phone connected").
  const stale = lastPairingConsumedAtMs();
  assert.equal(consumePairingCode("0".repeat(32)), false);
  assert.equal(lastPairingConsumedAtMs(), stale);
});

test("cookie secret is stable across calls and verifies only exactly", () => {
  const secret = getPhoneBrowserCookieSecret();
  assert.equal(getPhoneBrowserCookieSecret(), secret); // persisted, not re-rolled
  assert.equal(verifyPhoneBrowserCookieValue(secret), true);
  assert.equal(verifyPhoneBrowserCookieValue("wrong"), false);
  assert.equal(verifyPhoneBrowserCookieValue(""), false);
  assert.equal(verifyPhoneBrowserCookieValue(null), false);
  assert.equal(verifyPhoneBrowserCookieValue(secret.slice(0, -1)), false);
});
