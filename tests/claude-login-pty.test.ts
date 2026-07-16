import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripAnsi,
  extractAuthUrl,
  looksLikeLoginSuccess,
  startPtyLogin,
  getLoginState,
  _resetLoginState,
} from "../lib/claude-login-pty.ts";

/**
 * PTY-driven Claude sign-in (Phase B).
 *
 * Every case drives a FAKE CLI (a shell stub) through the REAL /usr/bin/script
 * pseudo-terminal — the exact path production uses — so we exercise pty
 * allocation, ANSI-wrapped URL capture, completion detection, timeouts, and
 * child reaping without ever spawning the real claude binary or touching its
 * auth. `statusCheck` is injected in every driver case so claudeStatus() (which
 * would spawn the real CLI) is never called. See the module header for why we
 * work from mocks: the CLI stores login state in the per-user macOS Keychain,
 * so spawning its real login flow is off-limits (AUTH SAFETY).
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

let dir: string;
const pidfiles: string[] = [];

/** Write an executable fake-CLI shell script that records its own pid, runs
 *  `body`, and returns its path + the pidfile it will write. */
function fakeCli(name: string, body: string): { cmd: string; pidfile: string } {
  const pidfile = path.join(dir, `${name}.pid`);
  pidfiles.push(pidfile);
  const p = path.join(dir, `${name}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\necho $$ > "${pidfile}"\n${body}\n`, { mode: 0o755 });
  return { cmd: p, pidfile };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(40);
  }
  return pred();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidfile: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-login-"));
});
after(() => {
  _resetLoginState();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
beforeEach(() => {
  _resetLoginState();
});

/* ---------------------------------------------------------------- pure bits */

test("stripAnsi removes color/cursor escapes but keeps the URL", () => {
  const colored = `${ESC}[34m${ESC}[1mhttps://claude.ai/oauth/authorize?code=abc${ESC}[0m`;
  assert.equal(stripAnsi(colored), "https://claude.ai/oauth/authorize?code=abc");
  // OSC title-set sequence is stripped too.
  assert.equal(stripAnsi(`${ESC}]0;window title${BEL}hello`), "hello");
});

test("extractAuthUrl is tolerant across wordings + hosts", () => {
  assert.equal(
    extractAuthUrl(`${ESC}[32mhttps://claude.ai/oauth/authorize?a=1${ESC}[0m`),
    "https://claude.ai/oauth/authorize?a=1"
  );
  assert.equal(
    extractAuthUrl("Please open the following URL:\n  https://console.anthropic.com/oauth/x?y=1 \n"),
    "https://console.anthropic.com/oauth/x?y=1"
  );
  // A device-code style URL only recognized by the "visit/open" line rule.
  assert.equal(
    extractAuthUrl("Visit https://auth.example.com/device?code=99 to continue."),
    "https://auth.example.com/device?code=99"
  );
  // Trailing punctuation is trimmed.
  assert.equal(
    extractAuthUrl("Open (https://claude.ai/oauth/go?z=2)."),
    "https://claude.ai/oauth/go?z=2"
  );
  // Nothing plausible yet.
  assert.equal(extractAuthUrl("Starting login...\nInitializing account"), null);
});

test("looksLikeLoginSuccess catches the CLI's completion wordings", () => {
  assert.equal(looksLikeLoginSuccess(`${ESC}[32mLogin successful!${ESC}[0m`), true);
  assert.equal(looksLikeLoginSuccess("You are now logged in."), true);
  assert.equal(looksLikeLoginSuccess("Authentication complete."), true);
  assert.equal(looksLikeLoginSuccess("waiting for your browser"), false);
});

test("login state defaults to idle and stays additive to the Phase A poll", () => {
  // The install route folds getLoginState() in under a NEW `login` key; Phase A
  // consumers (which only read phase/done/ok/logTail/connection) are unaffected.
  // Default must be a bare { state: "idle" } — no url leaked when idle.
  _resetLoginState();
  const s = getLoginState();
  assert.equal(s.state, "idle");
  assert.equal(s.url, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { state: "idle" });
});

/* -------------------------------------------------------------- the driver */

test("delayed ANSI URL is captured through the real pty, then flips to done", async () => {
  const { cmd, pidfile } = fakeCli(
    "delayed",
    `sleep 0.3\nprintf '${ESC}[34mopen https://claude.ai/oauth/authorize?code=xyz${ESC}[0m\\n'\nsleep 30`
  );
  // Injected status: signed-out until we've seen the URL, then signed-in.
  let checks = 0;
  const statusCheck = async () => (++checks >= 2 ? "signed-in" : "signed-out");

  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    statusCheck,
    urlTimeoutMs: 5000,
    completionTimeoutMs: 20_000,
    pollIntervalMs: 100,
  });
  assert.equal(r.spawned, true);

  const gotUrl = await waitFor(() => getLoginState().state === "url-ready", 5000);
  assert.equal(gotUrl, true, "should reach url-ready");
  const st = getLoginState();
  assert.equal(st.url, "https://claude.ai/oauth/authorize?code=xyz");
  assert.equal(st.method, "pty");

  const fakePid = readPid(pidfile);
  assert.ok(fakePid, "fake CLI should have written its pid");

  const done = await waitFor(() => getLoginState().state === "done", 5000);
  assert.equal(done, true, "should flip to done once statusCheck reports signed-in");

  // The pty child tree must be reaped — no orphaned processes.
  const reaped = await waitFor(() => !isAlive(fakePid!), 4000);
  assert.equal(reaped, true, "fake CLI process must be reaped on done");
});

test("instant URL reaches url-ready immediately", async () => {
  const { cmd } = fakeCli(
    "instant",
    `printf 'Visit https://claude.ai/oauth/authorize?code=instant to sign in\\n'\nsleep 30`
  );
  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    statusCheck: async () => "signed-out",
    urlTimeoutMs: 5000,
    completionTimeoutMs: 20_000,
    pollIntervalMs: 200,
  });
  assert.equal(r.spawned, true);
  const gotUrl = await waitFor(() => getLoginState().state === "url-ready", 5000);
  assert.equal(gotUrl, true);
  assert.equal(getLoginState().url, "https://claude.ai/oauth/authorize?code=instant");
});

test("no URL within the timeout fails over to the blind spawn and reaps the pty", async () => {
  const { cmd, pidfile } = fakeCli("nourl", `printf 'Loading your account...\\n'\nsleep 30`);
  let failedOver = false;
  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    statusCheck: async () => "signed-out",
    // Long enough for the pty child to boot + record its pid under full-suite
    // load, short enough to trip well before the fake's 30s sleep (it never
    // prints a URL, so any sub-30s timeout fails over).
    urlTimeoutMs: 2000,
    completionTimeoutMs: 20_000,
    pollIntervalMs: 200,
    onFailover: () => {
      failedOver = true;
    },
  });
  assert.equal(r.spawned, true);
  const over = await waitFor(() => failedOver, 4000);
  assert.equal(over, true, "URL timeout must trigger the blind-spawn failover");

  const fakePid = readPid(pidfile);
  assert.ok(fakePid);
  const reaped = await waitFor(() => !isAlive(fakePid!), 4000);
  assert.equal(reaped, true, "pty child must be reaped on failover");
});

test("immediate exit before any URL fails over", async () => {
  const { cmd } = fakeCli("exit", `printf 'starting\\n'\nexit 0`);
  let failedOver = false;
  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    statusCheck: async () => "signed-out",
    urlTimeoutMs: 5000,
    completionTimeoutMs: 20_000,
    onFailover: () => {
      failedOver = true;
    },
  });
  assert.equal(r.spawned, true);
  // Timing-sensitive: the failover fires when the child exits, but under
  // full-suite load the pty spawn + exit detection can lag, so give it generous
  // headroom rather than racing a 4s window on a busy box.
  const over = await waitFor(() => failedOver, 8000);
  assert.equal(over, true, "a child that exits before a URL must fail over");
});

test("completion timeout after url-ready marks failed and reaps", async () => {
  const { cmd, pidfile } = fakeCli(
    "timeout",
    `printf 'open https://claude.ai/oauth/authorize?code=tt\\n'\nsleep 30`
  );
  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    statusCheck: async () => "signed-out", // never completes
    urlTimeoutMs: 5000,
    completionTimeoutMs: 600, // trip the completion cap quickly
    pollIntervalMs: 150,
  });
  assert.equal(r.spawned, true);
  assert.equal(await waitFor(() => getLoginState().state === "url-ready", 5000), true);
  const failed = await waitFor(() => getLoginState().state === "failed", 4000);
  assert.equal(failed, true, "completion cap should mark the login failed");
  const fakePid = readPid(pidfile);
  assert.ok(fakePid);
  assert.equal(await waitFor(() => !isAlive(fakePid!), 4000), true, "reaped on completion timeout");
});

test("single-flight: a second start while active does not spawn a second CLI", async () => {
  const { cmd, pidfile } = fakeCli(
    "single",
    `printf 'open https://claude.ai/oauth/authorize?code=one\\n'\nsleep 30`
  );
  const opts = {
    commandOverride: cmd,
    argvOverride: [],
    statusCheck: async () => "signed-out",
    urlTimeoutMs: 5000,
    completionTimeoutMs: 20_000,
    pollIntervalMs: 300,
  };
  const first = await startPtyLogin(opts);
  assert.equal(first.spawned, true);
  assert.equal(await waitFor(() => getLoginState().state === "url-ready", 5000), true);
  const firstPid = readPid(pidfile);

  // Second call while url-ready: single-flight returns spawned without a new spawn.
  const second = await startPtyLogin(opts);
  assert.equal(second.spawned, true);
  await sleep(300);
  const stillPid = readPid(pidfile);
  assert.equal(stillPid, firstPid, "the pidfile must be unchanged — no second CLI launched");
  assert.equal(getLoginState().url, "https://claude.ai/oauth/authorize?code=one");
});

test("startPtyLogin returns spawned:false when no pty tool exists", async () => {
  const { cmd } = fakeCli("nopty", `printf 'x\\n'\nexit 0`);
  const r = await startPtyLogin({
    commandOverride: cmd,
    argvOverride: [],
    scriptBin: "/nonexistent/pty-tool",
    statusCheck: async () => "signed-out",
  });
  // resolvePtyBin falls back to real /usr/bin/script/expect only when scriptBin
  // is undefined; an explicit bad override is honored → cannot start.
  assert.equal(r.spawned, false);
});
