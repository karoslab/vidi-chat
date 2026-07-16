import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tier-2 (S-redact). Journal / shared-memory / MyWiki-note writes can carry a
 * secret (a tool result that echoed an Authorization header, one of vidi's own
 * bearer tokens). redactSecrets() scrubs known secret shapes AND the machine's
 * own live tokens (read from data/) before the write. Assert both layers, the
 * legibility of the redaction (label preserved), and fail-open behavior.
 */

// Isolate data/ and seed a real control token so the own-token layer has a
// concrete value to strip — BEFORE importing the module (dataDir is call-time,
// but seed first for clarity).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-redact-"));
process.chdir(tmp);
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
const OWN_CONTROL_TOKEN = "aVeryLongMachineLocalControlTokenValue123";
fs.writeFileSync(path.join(tmp, "data", "control-token"), OWN_CONTROL_TOKEN + "\n");
fs.writeFileSync(path.join(tmp, "data", "phone-token"), "abcdef0123456789abcdef0123456789\n");

const { redactSecrets } = await import("../lib/redact.ts");

test("redacts this machine's own control/phone tokens by exact match", () => {
  const out = redactSecrets(`ran: curl -H "x-vidi-control-token: ${OWN_CONTROL_TOKEN}" localhost`);
  assert.ok(!out.includes(OWN_CONTROL_TOKEN), "own control token must be gone");
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts Bearer tokens, preserving the label", () => {
  const out = redactSecrets("Authorization: Bearer abcDEF1234567890xyz");
  assert.ok(!out.includes("abcDEF1234567890xyz"));
  assert.match(out, /Bearer \[REDACTED\]/);
});

test("redacts sk-/AKIA/ghp_ style keys", () => {
  assert.ok(!redactSecrets("key sk-ant-abcdefghij1234567890").includes("abcdefghij"));
  assert.ok(!redactSecrets("AKIAIOSFODNN7EXAMPLE").includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!redactSecrets("token ghp_abcdefghijklmnopqrstuvwx0123").includes("ghp_abcdefghij"));
});

test("redacts x-vidi-key and labelled key=value secrets", () => {
  assert.match(redactSecrets(`x-vidi-key: super-secret-proxy-value`), /x-vidi-key: \[REDACTED\]/i);
  assert.match(redactSecrets(`api_key=abcdefgh12345678`), /api[_-]?key: \[REDACTED\]/i);
  assert.match(redactSecrets(`password: hunter2hunter2`), /password: \[REDACTED\]/i);
});

test("leaves benign text untouched", () => {
  const benign = "opened the mail app and read the top message";
  assert.equal(redactSecrets(benign), benign);
  assert.equal(redactSecrets(""), "");
});

test("does not redact a too-short own token (would nuke ordinary text)", () => {
  // A 1-2 char token file must not turn every occurrence of that char into
  // [REDACTED]; the module only strips own tokens of length >= 8.
  fs.writeFileSync(path.join(tmp, "data", "hands-token"), "ab\n");
  const out = redactSecrets("a normal sentence about a cab and a lab");
  assert.equal(out, "a normal sentence about a cab and a lab");
});
