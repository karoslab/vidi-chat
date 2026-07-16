import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, secureDataFile } from "./data-dir.ts";
import { resolveClaudeBin } from "./credential-detect.ts";
import { startPtyLogin, noteBlindSpawn, getLoginState, type LoginStatus } from "./claude-login-pty.ts";

/**
 * Server-side "Connect Claude" setup module (Phase A of the Helper demotion).
 *
 * This is the in-app port of the native Vidi Helper's `Connect AI provider`
 * flow (vidi-launcher "Vidi Helper.app"/.../lib/common.sh + menu.sh): install
 * the Claude CLI, then sign in — so a non-technical customer connects Claude
 * from inside onboarding, never opening the Helper menu or Terminal.
 *
 * The whole surface is fail-safe: every public function returns a value instead
 * of throwing, so the onboarding journey (whose verify() must never throw) can
 * consume it directly. Everything the install does is appended to a support log
 * under the data dir (never swallowed), which a failure screen points at.
 *
 * SECURITY: the CLI path is resolved ONLY from the trusted seam
 * (resolveClaudeBin: CLAUDE_BIN env > user-config > PATH) or the install
 * targets below — NEVER from request input. The two install commands are FIXED
 * strings (constants, or env overrides set by the launchd plist / test harness);
 * no user input is ever interpolated into a shell command.
 */

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

export type ClaudeSetupStatus = "missing" | "signed-out" | "signed-in";

/** Per-probe hard timeout — the CLI's --help / auth status return in well under
 *  a second; 5s is generous headroom for a cold spawn without ever hanging the
 *  onboarding step. */
export const PROBE_TIMEOUT_MS = 5000;

interface CaptureResult {
  /** the binary could be spawned at all (false = ENOENT). */
  spawned: boolean;
  /** exit code (null = killed by the timeout / a signal). */
  exitCode: number | null;
  /** combined stdout+stderr, truncated — for classification + the log, never
   *  surfaced to the customer. */
  output: string;
}

/** node's bin dir prepended to PATH so a node-script `claude` launcher (METHOD 2
 *  npm install) can exec node even if the caller's PATH lacks it. Mirrors the
 *  launcher's `PATH="$(dirname "$NODE_BIN"):$PATH"`. */
function childPath(): string {
  const nodeDir = path.dirname(process.execPath);
  const current = process.env.PATH || "";
  return current ? `${nodeDir}${path.delimiter}${current}` : nodeDir;
}

/** Run `bin args...` to completion, capturing exit + output. NEVER throws — a
 *  spawn error / timeout resolves to a not-spawned or killed CaptureResult. The
 *  env is inherited (fixed, non-model-directed probe — no request input reaches
 *  it, same reasoning as credential-detect's status probe). */
function capture(bin: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CaptureResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: childPath() },
      });
    } catch {
      finish({ spawned: false, exitCode: null, output: "" });
      return;
    }
    let output = "";
    const grab = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(0, 8000);
    };
    child.stdout?.on("data", grab);
    child.stderr?.on("data", grab);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ spawned: true, exitCode: null, output });
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      finish({ spawned: false, exitCode: null, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ spawned: true, exitCode: code, output });
    });
  });
}

/**
 * Discover the CLI's REAL status verbs at runtime from its --help output, then
 * fall back to the launcher's chain (`auth status`, then `whoami`). This matters
 * because the verb has moved across versions: 2.1.x exposes `claude auth status`
 * and has NO top-level `whoami`, and a blind `claude whoami`/`claude login` is
 * read as a PROMPT (it would start a session), so we must only run verbs the
 * installed CLI actually advertises. If the help probes yield nothing usable we
 * try both candidates anyway — a spawn of a non-verb just exits non-zero.
 */
export async function discoverStatusArgv(bin: string): Promise<string[][]> {
  const candidates: string[][] = [];
  const authHelp = await capture(bin, ["auth", "--help"]);
  if (authHelp.spawned && /\bstatus\b/.test(authHelp.output.toLowerCase())) {
    candidates.push(["auth", "status"]);
  }
  const topHelp = await capture(bin, ["--help"]);
  if (topHelp.spawned && /\bwhoami\b/.test(topHelp.output.toLowerCase())) {
    candidates.push(["whoami"]);
  }
  if (candidates.length === 0) candidates.push(["auth", "status"], ["whoami"]);
  return candidates;
}

/** Explicit "signed out" text — used as a belt so an `auth status` that prints a
 *  denial but still exits 0 (seen on some CLI builds) is not misread as signed
 *  in. Mirrors credential-detect.interpretProbe's deniesLogin set. */
function deniesLogin(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("not logged in") ||
    lower.includes("not signed in") ||
    lower.includes("logged out") ||
    lower.includes('"loggedin": false') ||
    lower.includes('"loggedin":false') ||
    lower.includes("/login") ||
    lower.includes("please run") ||
    lower.includes("please log in")
  );
}

/**
 * The tri-state the UI branches on: "missing" (no CLI), "signed-out" (CLI runs
 * but no account), "signed-in" (a turn would work). Fully mechanical + fail-safe
 * — any surprise resolves to "missing"/"signed-out", never a throw. Zero-exit on
 * a discovered status verb === signed-in (the launcher's claude_status rule),
 * unless the output explicitly denies login.
 */
export async function claudeStatus(): Promise<ClaudeSetupStatus> {
  try {
    const bin = resolveInstalledClaude();
    if (!bin) return "missing";
    const argvs = await discoverStatusArgv(bin);
    let sawSpawn = false;
    for (const argv of argvs) {
      const r = await capture(bin, argv);
      if (!r.spawned) continue;
      sawSpawn = true;
      if (r.exitCode === 0 && !deniesLogin(r.output)) return "signed-in";
    }
    // Bin resolved → it is installed; no verb confirmed a session → signed out.
    return sawSpawn ? "signed-out" : "signed-out";
  } catch {
    return "missing";
  }
}

/* -------------------------------------------------------------------------- */
/* install targets + resolution                                               */
/* -------------------------------------------------------------------------- */

/** Where METHOD 1 (the official installer) places the binary: ~/.local/bin/claude
 *  — which is exactly the default user-config `claudeBin` the app already
 *  resolves. Overridable so a test's stub install command can drop a fake binary
 *  somewhere the readiness check will then run. */
export function officialTargetBin(): string {
  return process.env.CLAUDE_INSTALL_TARGET_BIN || path.join(os.homedir(), ".local", "bin", "claude");
}

/** METHOD 2 (npm) install prefix — per-user, never global, never sudo. The
 *  runnable launcher lands at <prefix>/node_modules/.bin/claude. */
export function toolsPrefix(): string {
  return process.env.CLAUDE_TOOLS_DIR || path.join(os.homedir(), ".local", "share", "vidi", "claude-tools");
}

function npmToolsBin(): string {
  return path.join(toolsPrefix(), "node_modules", ".bin", "claude");
}

/** Resolve the claude binary for status/login: the trusted seam first
 *  (CLAUDE_BIN > user-config > PATH), then the two install targets (a fresh
 *  install may not be on PATH yet). Returns null when none is present. */
export function resolveInstalledClaude(): string | null {
  const seam = resolveClaudeBin();
  if (seam) return seam;
  for (const p of [officialTargetBin(), npmToolsBin()]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* support log                                                                */
/* -------------------------------------------------------------------------- */

/** The append-only support log — every install's full output lands here and the
 *  failure screen surfaces its tail, so a support call has the real error rather
 *  than a bare "couldn't install". */
export function claudeInstallLogPath(): string {
  return path.join(dataDir(), "claude-install.log");
}

function logAppend(text: string): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(claudeInstallLogPath(), text);
    secureDataFile(claudeInstallLogPath());
  } catch {
    /* a log write must never break the install */
  }
}

/** Last `maxLines` lines of the support log (safe to show — it is our own
 *  install output, never customer secrets). Empty string when absent. */
export function readInstallLogTail(maxLines = 40): string {
  try {
    const raw = fs.readFileSync(claudeInstallLogPath(), "utf8");
    const lines = raw.split("\n");
    return lines.slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* readiness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The REAL "is it installed" gate (ported from claude_ready): the launcher file
 * existing proves nothing — @anthropic-ai/claude-code ships a placeholder stub
 * at node_modules/.bin/claude that exists even when the postinstall never placed
 * the native binary. So we INVOKE it: a real install prints a semver from
 * `--version`; the stub prints an instruction line with no version.
 */
async function runsWithSemver(bin: string): Promise<{ ok: boolean; version: string }> {
  const r = await capture(bin, ["--version"], 15_000);
  const version = r.output.trim();
  const ok = r.exitCode === 0 && /[0-9]+\.[0-9]+/.test(version);
  return { ok, version };
}

/* -------------------------------------------------------------------------- */
/* install                                                                     */
/* -------------------------------------------------------------------------- */

export type InstallPhase =
  | "idle"
  | "installing"
  | "installing-fallback"
  | "verifying"
  | "done"
  | "failed";

export interface InstallState {
  phase: InstallPhase;
  running: boolean;
  done: boolean;
  ok: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface InstallResult {
  ok: boolean;
  /** the resolved runnable binary, on success. */
  bin?: string;
  /** a SHORT plain-language reason on failure (never raw stderr). */
  reason?: string;
}

let state: InstallState = {
  phase: "idle",
  running: false,
  done: false,
  ok: false,
  startedAt: null,
  finishedAt: null,
};

/** Single-flight guard: the in-flight install promise, shared by concurrent
 *  callers so two requests can never run two installs at once. */
let inflight: Promise<InstallResult> | null = null;

export function getInstallState(): InstallState {
  return { ...state };
}

/** Run a FIXED shell command (constant or trusted env override — never request
 *  input), appending all output to the support log. Resolves the exit code. */
function runInstallCommand(cmd: string, cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/bash", ["-c", cmd], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: childPath() },
      });
    } catch (e) {
      logAppend(`\n[spawn error] ${(e as Error).message}\n`);
      resolve(127);
      return;
    }
    const grab = (chunk: Buffer) => logAppend(chunk.toString());
    child.stdout?.on("data", grab);
    child.stderr?.on("data", grab);
    child.on("error", (e) => {
      logAppend(`\n[command error] ${e.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Map the support log to a customer-friendly failure reason (ported from
 *  claude_install_reason, minus the launcher-only Rosetta case). */
function installFailureReason(): string {
  const log = readInstallLogTail(200).toLowerCase();
  if (/enotfound|etimedout|econnreset|enetunreach|getaddrinfo|socket hang|network|could not resolve/.test(log)) {
    return "The download did not finish. Your internet connection may have dropped during setup. Reconnect to Wi-Fi and try Install again.";
  }
  if (/enospc|no space left/.test(log)) {
    return "There wasn't enough free disk space to finish the install. Free up some space, then try again.";
  }
  return "A required piece of the AI brain didn't finish installing. Nothing on your Mac was changed. You can try again, or ask for help on the call.";
}

/** METHOD 1 — the official native installer. Overridable (CLAUDE_OFFICIAL_INSTALL_CMD,
 *  mirroring the launcher harness) so tests stand in a network-free stub; the
 *  default runs the real curl|bash on a customer Mac. */
function officialInstallCmd(): string {
  return process.env.CLAUDE_OFFICIAL_INSTALL_CMD || "curl -fsSL https://claude.ai/install.sh | bash";
}

/** METHOD 2 — the bundled-npm fallback. --include=optional FORCES the native
 *  optional dep even if a stray npmrc set omit=optional; scripts stay ON (never
 *  --ignore-scripts) so the postinstall places the binary. Overridable so tests
 *  stand in a fake npm. */
function npmInstallCmd(): string {
  if (process.env.CLAUDE_NPM_INSTALL_CMD) return process.env.CLAUDE_NPM_INSTALL_CMD;
  const prefix = toolsPrefix();
  return (
    `npm install --no-audit --no-fund --include=optional ` +
    `--prefix ${JSON.stringify(prefix)} @anthropic-ai/claude-code`
  );
}

async function doInstall(): Promise<InstallResult> {
  state = { phase: "installing", running: true, done: false, ok: false, startedAt: Date.now(), finishedAt: null };
  logAppend(
    `\n===== claude install ${new Date().toISOString()} =====\n` +
      `node: ${process.version} (${process.arch}) platform=${process.platform}\n`
  );

  const finish = (ok: boolean, bin?: string, reason?: string): InstallResult => {
    state = { ...state, phase: ok ? "done" : "failed", running: false, done: true, ok, finishedAt: Date.now() };
    logAppend(ok ? `RESULT: OK — ${bin}\n` : `RESULT: FAILED — ${reason}\n`);
    return ok ? { ok, bin } : { ok, reason };
  };

  // METHOD 1 — official installer → ~/.local/bin/claude.
  logAppend(`--- METHOD 1: official installer: ${officialInstallCmd()} ---\n`);
  const rc1 = await runInstallCommand(officialInstallCmd());
  logAppend(`official installer exit: ${rc1}\n`);
  const target = officialTargetBin();
  if (fs.existsSync(target)) {
    state = { ...state, phase: "verifying" };
    const ready = await runsWithSemver(target);
    logAppend(`--- readiness (official): claude --version → "${ready.version}" (ok=${ready.ok}) ---\n`);
    if (ready.ok) return finish(true, target);
  }
  logAppend(`--- official installer did not yield a runnable claude; falling back to npm ---\n`);

  // METHOD 2 — npm into the tools prefix, then EXPLICITLY run install.cjs.
  state = { ...state, phase: "installing-fallback" };
  try {
    fs.mkdirSync(toolsPrefix(), { recursive: true });
  } catch {
    /* the npm command will report a real error if the dir is unusable */
  }
  logAppend(`--- METHOD 2: npm install (--include=optional) ---\n`);
  const rc2 = await runInstallCommand(npmInstallCmd(), toolsPrefix());
  logAppend(`npm exit: ${rc2}\n`);

  // Re-run the postinstall that places the native binary over the bin/claude.exe
  // placeholder — npm SHOULD have, but a global ignore-scripts npmrc or a partial
  // failure can leave only the stub; re-running install.cjs is idempotent.
  const installCjs = path.join(toolsPrefix(), "node_modules", "@anthropic-ai", "claude-code", "install.cjs");
  if (fs.existsSync(installCjs)) {
    logAppend(`--- postinstall: node install.cjs ---\n`);
    await runInstallCommand(`${JSON.stringify(process.execPath)} ${JSON.stringify(installCjs)}`, path.dirname(installCjs));
  } else {
    logAppend(`--- postinstall: install.cjs NOT FOUND at ${installCjs} ---\n`);
  }

  const npmBin = npmToolsBin();
  if (fs.existsSync(npmBin)) {
    // Symlink into the resolved target so the app's normal bin resolution finds
    // it (mirrors the launcher's ln -sf native_bin → CLAUDE_BUNDLED_BIN).
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.unlinkSync(target);
      } catch {
        /* not there yet */
      }
      fs.symlinkSync(npmBin, target);
    } catch {
      /* symlink best-effort — readiness runs the npm bin directly below */
    }
    state = { ...state, phase: "verifying" };
    const runnable = fs.existsSync(target) ? target : npmBin;
    const ready = await runsWithSemver(runnable);
    logAppend(`--- readiness (npm): claude --version → "${ready.version}" (ok=${ready.ok}) ---\n`);
    if (ready.ok) return finish(true, runnable);
  }

  return finish(false, undefined, installFailureReason());
}

/**
 * Install the Claude CLI: METHOD 1 (official native installer) → METHOD 2
 * (bundled-npm fallback + explicit postinstall + readiness). Single-flight: a
 * concurrent call returns the SAME in-flight promise, so two requests can never
 * launch two installs. Never throws.
 */
export function installClaude(): Promise<InstallResult> {
  if (inflight) return inflight;
  inflight = doInstall().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Test-only: reset the module state (install flags + single-flight latch)
 *  between cases. Not used in production. */
export function _resetClaudeSetupState(): void {
  state = { phase: "idle", running: false, done: false, ok: false, startedAt: null, finishedAt: null };
  inflight = null;
}

/* -------------------------------------------------------------------------- */
/* login (Phase A: blind spawn; Phase B replaces internals with a PTY driver)  */
/* -------------------------------------------------------------------------- */

/** Re-exported so the status route reads the live login state (state + url +
 *  method) from the same setup surface it already imports. See
 *  lib/claude-login-pty.ts for the state machine. */
export { getLoginState };
export type { LoginStatus };

/** The login state the status route folds into its JSON. */
export function loginState(): LoginStatus {
  return getLoginState();
}

/**
 * Discover the CLI's real sign-in verb from --help: 2.1.x uses `claude auth
 * login` (a blind `claude login` is read as a prompt), older builds used
 * `claude login`. Falls back to `auth login` (the current, safest form).
 */
export async function discoverLoginArgv(bin: string): Promise<string[]> {
  const authHelp = await capture(bin, ["auth", "--help"]);
  if (authHelp.spawned && /\blogin\b/.test(authHelp.output.toLowerCase())) return ["auth", "login"];
  const topHelp = await capture(bin, ["--help"]);
  if (topHelp.spawned && /\blogin\b/.test(topHelp.output.toLowerCase())) return ["login"];
  return ["auth", "login"];
}

/**
 * The v1 "blind spawn": a detached, no-controlling-terminal spawn of the CLI's
 * login verb — the CLI opens the customer's browser to sign in with THEIR OWN
 * account, exactly like the Helper menu does, but we never see the OAuth URL.
 * Phase B keeps this as the FALLBACK path (used when the PTY driver can't run or
 * doesn't surface a URL in time), and marks the login state as blind-driven so
 * the UI shows the Phase A "your browser should have opened" UX. Never throws.
 */
export function blindSpawnLogin(): { spawned: boolean } {
  try {
    const bin = resolveInstalledClaude();
    if (!bin) {
      noteBlindSpawn(false);
      return { spawned: false };
    }
    // discoverLoginArgv is async, but the blind spawn is a best-effort fire-
    // and-forget; resolve the verb synchronously to the current, safest form
    // (`auth login`) — the PTY driver already probed --help on the happy path.
    const argv = ["auth", "login"];
    const child = spawn(bin, argv, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: childPath() },
    });
    child.unref();
    logAppend(`\n[login] blind spawn ${bin} ${argv.join(" ")} (${new Date().toISOString()})\n`);
    noteBlindSpawn(true);
    return { spawned: true };
  } catch (e) {
    logAppend(`\n[login] blind spawn failed: ${(e as Error).message}\n`);
    noteBlindSpawn(false);
    return { spawned: false };
  }
}

/**
 * Start the interactive sign-in. Phase B drives it through a pseudo-terminal
 * (lib/claude-login-pty) so the CLI's OAuth URL can be lifted from its stdout
 * and shown as a clickable button; the live login state (idle/starting/
 * url-ready/waiting/done/failed + url) surfaces through getLoginState(), which
 * the status route folds into its JSON. If the PTY path cannot even start
 * (no script/expect, or the spawn throws), we fall back to the Phase A blind
 * spawn automatically. SAME external signature as Phase A —
 * startLogin(): Promise<{ spawned }> — so existing consumers are unaffected.
 * Never throws.
 */
export async function startLogin(): Promise<{ spawned: boolean }> {
  try {
    const r = await startPtyLogin({
      log: logAppend,
      // URL-timeout / post-spawn PTY failure → the blind spawn opens the browser.
      onFailover: () => {
        blindSpawnLogin();
      },
    });
    if (r.spawned) return { spawned: true };
  } catch (e) {
    logAppend(`\n[login] pty driver threw: ${(e as Error).message}\n`);
  }
  // PTY path could not start at all → Phase A blind spawn.
  return blindSpawnLogin();
}
