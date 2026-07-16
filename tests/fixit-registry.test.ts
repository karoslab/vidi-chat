import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fix-It Mode Phase A (PLAN-VIDI-FIXIT.md §2, §6) — the T0 read-only registry.
 *
 * Asserts:
 *  - only a REGISTERED id executes; an unknown/unregistered id never runs and
 *    returns a calm spoken line (the registry is the security boundary, §2).
 *  - each T0 executor returns a non-empty spoken string.
 *  - NO SECRET BYTES (§5, B5): no executor output contains a token-like string.
 *
 * Isolation: VIDI_DATA_DIR points at a per-file temp dir so nothing touches the
 * real install's data/. A cache-busted import re-reads env. detectBackends()
 * shells out to `claude`/`codex` status probes — which are read-only, tokenless
 * liveness checks (credential-detect.ts) and fail-safe to "not connected" when
 * the binaries are absent, so the tests are deterministic either way.
 */

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fixit-registry-"));
process.env.VIDI_DATA_DIR = testDataDir;

const { runFixitCommand, isFixitCommand } = await import("../lib/fixit-registry.ts");

/**
 * A conservative "does this look like a leaked secret/token byte-string" check
 * for the B5 no-secret-bytes assertion. It flags the credential-token shapes
 * the CLIs actually mint (sk-…, sk-ant-…, ChatGPT/OpenAI session `sess-…`,
 * long opaque `Bearer`/JWT-ish runs) — NOT ordinary prose, so a spoken status
 * line ("Claude Max is connected.") passes while an accidentally-echoed key
 * fails.
 */
function containsTokenLikeString(text: string): boolean {
  const tokenPatterns: RegExp[] = [
    /sk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic-style API keys
    /sess-[A-Za-z0-9_-]{16,}/, // session tokens
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i, // bearer headers
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT (header.payload)
    /[A-Za-z0-9_-]{40,}/, // any single opaque run of >=40 token-ish chars
  ];
  return tokenPatterns.some((pattern) => pattern.test(text));
}

const T0_COMMAND_IDS = ["status.whatsMySetup", "creds.recheck", "brain.verify"] as const;

test("every Phase A T0 id is a registered fix-it command", () => {
  for (const commandId of T0_COMMAND_IDS) {
    assert.equal(isFixitCommand(commandId), true, `${commandId} should be registered`);
  }
});

test("an unknown id is NOT a registered command", () => {
  assert.equal(isFixitCommand("kill.clear"), false);
  assert.equal(isFixitCommand("voice.restart"), false);
  assert.equal(isFixitCommand("model.set"), false);
  assert.equal(isFixitCommand("definitely.not.a.command"), false);
});

test("runFixitCommand refuses an unregistered id — never executes, calm line", async () => {
  const spoken = await runFixitCommand("kill.clear");
  assert.equal(typeof spoken, "string");
  assert.ok(spoken.length > 0);
  // It should be the "I don't know how to do that" refusal, not a status line.
  assert.match(spoken, /don't know how/i);
});

test("runFixitCommand refuses arbitrary garbage without throwing", async () => {
  const spoken = await runFixitCommand("../../etc/passwd");
  assert.equal(typeof spoken, "string");
  assert.ok(spoken.length > 0);
  assert.match(spoken, /don't know how/i);
});

for (const commandId of T0_COMMAND_IDS) {
  test(`${commandId} returns a non-empty spoken string`, async () => {
    const spoken = await runFixitCommand(commandId);
    assert.equal(typeof spoken, "string");
    assert.ok(spoken.trim().length > 0, `${commandId} spoke nothing`);
  });

  test(`${commandId} output contains NO token-like secret bytes (B5)`, async () => {
    const spoken = await runFixitCommand(commandId);
    assert.equal(
      containsTokenLikeString(spoken),
      false,
      `${commandId} leaked a token-like string: ${JSON.stringify(spoken)}`
    );
  });
}
