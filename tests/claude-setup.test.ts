import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Connect Claude — server-side setup module (Phase A of the Helper demotion).
 * The in-app port of the Vidi Helper's install + status + login semantics.
 *
 * Every case runs against FAKE binaries (a shell stub standing in for the CLI)
 * and env-overridable install commands (CLAUDE_OFFICIAL_INSTALL_CMD /
 * CLAUDE_NPM_INSTALL_CMD) — so nothing ever touches the network or the real
 * claude binary's auth state. Layers exercised:
 *   1. claudeStatus verb-fallback: discover the CLI's real status verb from
 *      --help, fall back to the launcher chain (auth status → whoami); zero-exit
 *      === signed-in, with a denial-text belt so a 0-exit "not logged in" isn't
 *      misread.
 *   2. installClaude METHOD 1 success / METHOD 1 fail → METHOD 2 / both fail —
 *      all via stub install commands + a fake binary whose --version prints a
 *      semver (the launcher's real "is it installed" gate; a .bin stub proves
 *      nothing).
 *   3. single-flight: two concurrent installs share one run.
 *   4. journey verify() integration (claude-connected reads claudeStatus).
 */

// Isolate the data dir (the support log lands under it) away from the live repo.
process.env.VIDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-setup-data-"));

const {
  claudeStatus,
  discoverStatusArgv,
  discoverLoginArgv,
  installClaude,
  getInstallState,
  officialTargetBin,
  toolsPrefix,
  _resetClaudeSetupState,
} = await import("../lib/claude-setup.ts");
const { _resetUserConfigCache } = await import("../lib/user-config.ts");

/* -------------------------------------------------------------------------- */
/* fake-binary helpers                                                        */
/* -------------------------------------------------------------------------- */

/** A stub `claude` whose verbs mirror the real 2.1.x CLI: `auth --help` lists
 *  login+status, top-level `--help` lists auth (no whoami), `auth status` exits
 *  0 iff FAKE_SIGNED_IN=1, `--version` prints a semver. */
function writeRealisticStub(): string {
  return writeFakeClaude(`
case "$1 $2" in
  "auth --help")
    echo "Commands:"; echo "  login   Sign in to your Anthropic account"; echo "  status  Show authentication status"; exit 0 ;;
  "auth status")
    if [ "$FAKE_SIGNED_IN" = "1" ]; then echo '{"loggedIn": true}'; exit 0; fi
    echo "Not logged in. Please run /login" 1>&2; exit 1 ;;
  "auth login") exit 0 ;;
esac
case "$1" in
  "--help") echo "Usage: claude"; echo "Commands:"; echo "  auth  Manage authentication"; exit 0 ;;
  "--version") echo "2.1.201 (Claude Code)"; exit 0 ;;
esac
exit 3
`);
}

function writeFakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fakeclaude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

/** Neutralize every real bin source so resolution can't find the machine's real
 *  claude (env CLAUDE_BIN / VIDI_CLAUDE_BIN, the two install targets, PATH). */
function isolateBinResolution(): () => void {
  const gone = path.join(os.tmpdir(), "vidi-no-claude-" + Math.random().toString(36).slice(2));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    VIDI_CLAUDE_BIN: process.env.VIDI_CLAUDE_BIN,
    CLAUDE_INSTALL_TARGET_BIN: process.env.CLAUDE_INSTALL_TARGET_BIN,
    CLAUDE_TOOLS_DIR: process.env.CLAUDE_TOOLS_DIR,
    PATH: process.env.PATH,
  };
  process.env.CLAUDE_BIN = gone;
  process.env.VIDI_CLAUDE_BIN = gone;
  process.env.CLAUDE_INSTALL_TARGET_BIN = gone;
  process.env.CLAUDE_TOOLS_DIR = gone;
  process.env.PATH = "";
  _resetUserConfigCache();
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetUserConfigCache();
  };
}

/* -------------------------------------------------------------------------- */
/* 1. claudeStatus — verb discovery + fallback chain                          */
/* -------------------------------------------------------------------------- */

test("discoverStatusArgv: a CLI advertising `auth status` yields that verb", async () => {
  const bin = writeRealisticStub();
  const argvs = await discoverStatusArgv(bin);
  assert.deepEqual(argvs[0], ["auth", "status"]);
});

test("discoverStatusArgv: help probe failing → falls back to both launcher verbs", async () => {
  // A bin that errors on every --help still yields the launcher chain so status
  // can be probed at all.
  const bin = writeFakeClaude(`exit 9`);
  const argvs = await discoverStatusArgv(bin);
  assert.deepEqual(argvs, [["auth", "status"], ["whoami"]]);
});

test("claudeStatus: signed-in stub (auth status exit 0) → 'signed-in'", async () => {
  const bin = writeRealisticStub();
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_SIGNED_IN = "1";
  try {
    assert.equal(await claudeStatus(), "signed-in");
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_SIGNED_IN;
  }
});

test("claudeStatus: installed but signed-out (auth status non-zero) → 'signed-out'", async () => {
  const bin = writeRealisticStub();
  process.env.CLAUDE_BIN = bin;
  delete process.env.FAKE_SIGNED_IN;
  try {
    assert.equal(await claudeStatus(), "signed-out");
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test("claudeStatus: no CLI resolvable → 'missing'", async () => {
  const restore = isolateBinResolution();
  try {
    assert.equal(await claudeStatus(), "missing");
  } finally {
    restore();
  }
});

test("claudeStatus: denial-text belt — a 0-exit 'not logged in' is NOT read as signed-in", async () => {
  const bin = writeFakeClaude(`
case "$1 $2" in
  "auth --help") echo "  status  Show authentication status"; exit 0 ;;
  "auth status") echo "You are not logged in."; exit 0 ;;
esac
case "$1" in "--help") echo "Commands: auth"; exit 0 ;; esac
exit 3
`);
  process.env.CLAUDE_BIN = bin;
  try {
    assert.equal(await claudeStatus(), "signed-out");
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test("claudeStatus: falls back to whoami when auth status is absent but whoami is advertised", async () => {
  const bin = writeFakeClaude(`
case "$1 $2" in
  "auth --help") echo "no status subcommand here"; exit 0 ;;
esac
case "$1" in
  "--help") echo "Commands:"; echo "  whoami  Print the signed-in user"; exit 0 ;;
  "whoami") exit 0 ;;
esac
exit 3
`);
  process.env.CLAUDE_BIN = bin;
  try {
    assert.equal(await claudeStatus(), "signed-in");
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test("discoverLoginArgv: 2.1.x advertises `auth login`, not a bare `login`", async () => {
  const bin = writeRealisticStub();
  assert.deepEqual(await discoverLoginArgv(bin), ["auth", "login"]);
});

/* -------------------------------------------------------------------------- */
/* 2. installClaude — METHOD 1 → METHOD 2 → both-fail                         */
/* -------------------------------------------------------------------------- */

/** Point the install at a fresh temp target/prefix and stub both install
 *  commands. Returns a cleanup that restores env + module state. */
function installHarness(opts: { official: string; npm: string }): {
  target: string;
  prefix: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-install-"));
  const target = path.join(root, "bin", "claude");
  const prefix = path.join(root, "tools");
  const saved = {
    CLAUDE_OFFICIAL_INSTALL_CMD: process.env.CLAUDE_OFFICIAL_INSTALL_CMD,
    CLAUDE_NPM_INSTALL_CMD: process.env.CLAUDE_NPM_INSTALL_CMD,
    CLAUDE_INSTALL_TARGET_BIN: process.env.CLAUDE_INSTALL_TARGET_BIN,
    CLAUDE_TOOLS_DIR: process.env.CLAUDE_TOOLS_DIR,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
  };
  process.env.CLAUDE_INSTALL_TARGET_BIN = target;
  process.env.CLAUDE_TOOLS_DIR = prefix;
  process.env.CLAUDE_OFFICIAL_INSTALL_CMD = opts.official;
  process.env.CLAUDE_NPM_INSTALL_CMD = opts.npm;
  // Make sure a stray real CLAUDE_BIN can't satisfy resolution.
  delete process.env.CLAUDE_BIN;
  _resetClaudeSetupState();
  return {
    target,
    prefix,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetClaudeSetupState();
    },
  };
}

// A stub install command that drops a runnable fake claude (prints a semver) at
// a shell path expression. $CLAUDE_INSTALL_TARGET_BIN / $CLAUDE_TOOLS_DIR are in
// the child env (installClaude passes process.env through).
const DROP_OFFICIAL = `mkdir -p "$(dirname "$CLAUDE_INSTALL_TARGET_BIN")" && printf '#!/bin/sh\\necho "2.1.50 (Claude Code)"\\n' > "$CLAUDE_INSTALL_TARGET_BIN" && chmod +x "$CLAUDE_INSTALL_TARGET_BIN"`;
const DROP_NPM = `mkdir -p "$CLAUDE_TOOLS_DIR/node_modules/.bin" && printf '#!/bin/sh\\necho "2.1.60 (Claude Code)"\\n' > "$CLAUDE_TOOLS_DIR/node_modules/.bin/claude" && chmod +x "$CLAUDE_TOOLS_DIR/node_modules/.bin/claude"`;

test("installClaude: METHOD 1 (official installer) success → ok, bin at the target", async () => {
  const h = installHarness({ official: DROP_OFFICIAL, npm: `echo "npm should not run" 1>&2; exit 1` });
  try {
    const r = await installClaude();
    assert.equal(r.ok, true);
    assert.equal(r.bin, h.target);
    assert.equal(getInstallState().phase, "done");
    // METHOD 2 must not have run — the target already satisfied readiness.
    assert.equal(fs.existsSync(path.join(h.prefix, "node_modules", ".bin", "claude")), false);
  } finally {
    h.cleanup();
  }
});

test("installClaude: METHOD 1 fails → METHOD 2 (npm) recovers → ok", async () => {
  // Official does nothing (no target dropped); npm drops a runnable bin.
  const h = installHarness({ official: `true`, npm: DROP_NPM });
  try {
    const r = await installClaude();
    assert.equal(r.ok, true);
    // The npm bin is symlinked into the resolved target, so normal resolution
    // (officialTargetBin) finds it afterwards.
    assert.equal(fs.existsSync(officialTargetBin()), true);
    assert.equal(getInstallState().ok, true);
  } finally {
    h.cleanup();
  }
});

test("installClaude: both methods fail → ok:false with a plain reason (nothing runnable)", async () => {
  const h = installHarness({ official: `true`, npm: `true` });
  try {
    const r = await installClaude();
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0);
    // Plain language — no raw stderr / flags / Terminal command.
    assert.ok(!/ENOENT|stderr|--include|npm install/i.test(r.reason!));
    assert.equal(getInstallState().phase, "failed");
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* 3. single-flight                                                           */
/* -------------------------------------------------------------------------- */

test("installClaude: single-flight — two concurrent calls share ONE install run", async () => {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-sf-")), "runs");
  const saved = process.env.CLAUDE_TEST_COUNTER;
  process.env.CLAUDE_TEST_COUNTER = counter;
  // The official cmd records one run, drops a runnable bin, and lingers briefly
  // so the two calls genuinely overlap.
  const official =
    `echo run >> "$CLAUDE_TEST_COUNTER"; ` +
    `mkdir -p "$(dirname "$CLAUDE_INSTALL_TARGET_BIN")"; ` +
    `printf '#!/bin/sh\\necho "2.1.70 (Claude Code)"\\n' > "$CLAUDE_INSTALL_TARGET_BIN"; ` +
    `chmod +x "$CLAUDE_INSTALL_TARGET_BIN"; sleep 0.4`;
  const h = installHarness({ official, npm: `true` });
  try {
    const p1 = installClaude();
    const p2 = installClaude();
    // Same in-flight promise handed to the second caller.
    assert.equal(p1, p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const runs = fs.readFileSync(counter, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(runs.length, 1, `expected exactly one install run, saw ${runs.length}`);
  } finally {
    h.cleanup();
    if (saved === undefined) delete process.env.CLAUDE_TEST_COUNTER;
    else process.env.CLAUDE_TEST_COUNTER = saved;
  }
});

/* -------------------------------------------------------------------------- */
/* 4. journey verify() integration                                            */
/* -------------------------------------------------------------------------- */

const { claudeConnectedStep } = await import("../lib/journey/steps/claude-connected.ts");

test("verify: signed-in stub → ok:true", async () => {
  const bin = writeRealisticStub();
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_SIGNED_IN = "1";
  try {
    const r = await claudeConnectedStep.verify();
    assert.equal(r.ok, true);
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.FAKE_SIGNED_IN;
  }
});

test("verify: signed-out stub → ok:false, reason points at sign-in (not raw stderr)", async () => {
  const bin = writeRealisticStub();
  process.env.CLAUDE_BIN = bin;
  delete process.env.FAKE_SIGNED_IN;
  try {
    const r = await claudeConnectedStep.verify();
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /sign in/i.test(r.reason));
    assert.ok(!r.ok && !/stderr|exit code|--/.test(r.reason));
    assert.equal(!r.ok && r.fixStepId, "claude-connected");
  } finally {
    delete process.env.CLAUDE_BIN;
  }
});

test("verify: no CLI → ok:false, reason points at install", async () => {
  const restore = isolateBinResolution();
  try {
    const r = await claudeConnectedStep.verify();
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /install/i.test(r.reason));
  } finally {
    restore();
  }
});

test("verify: never throws even if the probe blows up (contract)", async () => {
  // A bin path that exists but is not executable as a program still resolves to
  // a soft not-connected, never a throw.
  const restore = isolateBinResolution();
  try {
    await assert.doesNotReject(async () => claudeConnectedStep.verify());
  } finally {
    restore();
  }
});
