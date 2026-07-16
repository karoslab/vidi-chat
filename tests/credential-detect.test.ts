import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectBackend,
  hintFor,
  interpretProbe,
  PROBE_TIMEOUT_MS,
  type ProbeResult,
} from "../lib/credential-detect.ts";
import { _resetUserConfigCache } from "../lib/user-config.ts";

/**
 * T2.1 — credential auto-detect + live-test. Two layers:
 *   1. interpretProbe / hintFor — the pure classifier: a status-subcommand
 *      outcome → installed/loggedIn + a plain-language hint. Never surfaces raw
 *      output. The load-bearing safety property: only a POSITIVELY confirmed
 *      "logged in" backend is offered; anything ambiguous is not-connected.
 *   2. detectBackend against FAKE binaries (a shell script standing in for the
 *      CLI) — exercises the real spawn/timeout path without a real CLI: a
 *      logged-in stub verifies, a missing binary is not-installed, and a
 *      hanging stub is killed by the hard timeout (never hangs onboarding).
 */

// ── Layer 1: the pure classifier ──────────────────────────────────────

function probe(partial: Partial<ProbeResult>): ProbeResult {
  return { spawned: true, exitCode: 0, output: "", ...partial };
}

test("claude: JSON loggedIn:true on exit 0 → verified", () => {
  const r = interpretProbe("claude", probe({ output: '{"loggedIn": true, "email": "x@y.com"}' }));
  assert.deepEqual(r, { installed: true, loggedIn: true });
});

test("codex: 'Logged in using ChatGPT' on exit 0 → verified", () => {
  const r = interpretProbe("codex", probe({ output: "Logged in using ChatGPT" }));
  assert.deepEqual(r, { installed: true, loggedIn: true });
});

test("not spawned (ENOENT) → not installed, not logged in", () => {
  const r = interpretProbe("claude", probe({ spawned: false, exitCode: null }));
  assert.deepEqual(r, { installed: false, loggedIn: false });
});

test("installed but signed out (loggedIn:false) → installed, not logged in", () => {
  const r = interpretProbe("claude", probe({ output: '{"loggedIn": false}' }));
  assert.deepEqual(r, { installed: true, loggedIn: false });
});

test("explicit 'not logged in' text → not logged in even on exit 0", () => {
  const r = interpretProbe("codex", probe({ exitCode: 0, output: "Not logged in. Please run codex login" }));
  assert.equal(r.installed, true);
  assert.equal(r.loggedIn, false);
});

test("a 'signed out' status that still returns 0 is not misread as logged in", () => {
  // Denial wins over any stray affirmative token.
  const r = interpretProbe("claude", probe({ exitCode: 0, output: '{"loggedIn": false, "note": "was logged in yesterday"}' }));
  assert.equal(r.loggedIn, false);
});

test("nonzero exit with no clear signal → not logged in (fail-safe)", () => {
  const r = interpretProbe("claude", probe({ exitCode: 1, output: "some error" }));
  assert.equal(r.installed, true);
  assert.equal(r.loggedIn, false);
});

test("timeout (exitCode null, no affirmation) → not logged in", () => {
  const r = interpretProbe("codex", probe({ exitCode: null, output: "" }));
  assert.equal(r.loggedIn, false);
});

test("hintFor: verified backend has no hint", () => {
  assert.equal(hintFor("claude", true, true), null);
  assert.equal(hintFor("codex", true, true), null);
});

test("hintFor: the not-verified hint points a non-technical user at the in-app connect step (no Terminal, no retired Helper menu)", () => {
  // For a non-technical user the installed-but-signed-out vs not-installed
  // distinction is meaningless — the action is the same either way: use the
  // in-app connect step (install + sign-in happen right in the app now). It
  // must NOT tell them to run a CLI command, open Terminal, or open the retired
  // Vidi Helper menu (that menu row was removed — launcher PR #12).
  const claudeMissing = hintFor("claude", false, false);
  const claudeSignedOut = hintFor("claude", true, false);
  assert.ok(claudeMissing);
  assert.equal(claudeMissing, claudeSignedOut);
  // Plain language, no raw stderr / flags / Terminal command.
  assert.ok(!/stderr|ENOENT|--/.test(claudeMissing!));
  assert.ok(!/Terminal|auth login|codex login|npm i/i.test(claudeMissing!));
  // The stranded copy is gone: never point a customer back at the Helper menu.
  assert.ok(!/Vidi Helper/.test(claudeMissing!));
  assert.ok(!/Connect AI provider/.test(claudeMissing!));
  assert.ok(!/Vidi Helper/.test(hintFor("codex", false, false)!));
  assert.ok(/sign in|connect/i.test(claudeMissing!));
});

// ── Layer 2: detectBackend against fake binaries (real spawn/timeout) ──

/** Write an executable stub script into a temp dir on PATH, standing in for the
 *  claude binary (resolved via CLAUDE_BIN). Returns the binary path. */
function writeFakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fakebin-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

test("detectBackend: logged-in stub verifies (green check)", async () => {
  const bin = writeFakeClaude(`echo '{"loggedIn": true}'; exit 0`);
  process.env.CLAUDE_BIN = bin;
  try {
    const status = await detectBackend("claude");
    assert.equal(status.installed, true);
    assert.equal(status.loggedIn, true);
    assert.equal(status.hint, null);
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test("detectBackend: missing binary → not installed, with a plain hint", async () => {
  // Force EVERY binary source to a gone path: CLAUDE_BIN, the user-config
  // claudeBin (via VIDI_CLAUDE_BIN + cache reset), and PATH — so no real claude
  // is found and detection reports not-installed.
  const gone = path.join(os.tmpdir(), "definitely-not-a-real-claude-binary-xyz");
  process.env.CLAUDE_BIN = gone;
  process.env.VIDI_CLAUDE_BIN = gone;
  _resetUserConfigCache();
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const status = await detectBackend("claude");
    assert.equal(status.installed, false);
    assert.equal(status.loggedIn, false);
    assert.ok(status.hint && status.hint.length > 0);
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.VIDI_CLAUDE_BIN;
    _resetUserConfigCache();
    process.env.PATH = savedPath;
  }
});

test("detectBackend: a hanging stub is killed by the hard timeout (never hangs)", async () => {
  // sleep longer than the probe timeout; detection must return promptly as
  // installed-but-not-connected rather than blocking onboarding forever.
  const bin = writeFakeClaude(`sleep 30`);
  process.env.CLAUDE_BIN = bin;
  try {
    const startedAt = Date.now();
    const status = await detectBackend("claude");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < PROBE_TIMEOUT_MS + 2000, `probe should return near the timeout, took ${elapsed}ms`);
    assert.equal(status.installed, true);
    assert.equal(status.loggedIn, false);
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});
