import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { claudeStatus, discoverLoginArgv, resolveInstalledClaude } from "./claude-setup.ts";

/**
 * PTY-driven Claude sign-in (Phase B of the Helper demotion).
 *
 * Phase A's startLogin() was a BLIND detached spawn of the CLI's login verb: it
 * opened the customer's browser but we never saw the OAuth URL, so a customer
 * whose browser did not pop had no way forward. This module drives that same
 * fixed CLI login through a pseudo-terminal so we can READ the CLI's own stdout,
 * lift the sign-in URL it prints, and surface it as a clickable button — the
 * Terminal-killer.
 *
 * No native deps: macOS ships /usr/bin/script (`script -q /dev/null <cmd...>`),
 * which allocates a real pty for the child, and /usr/bin/expect as a fallback.
 * We never handle credentials — the URL we show comes verbatim from the CLI's
 * stdout, and the CLI itself completes the OAuth exchange and stores the login
 * (on macOS, in the per-user Keychain). See THREAT_MODEL.md.
 *
 * SECURITY: the command is the SAME fixed CLI binary Phase A resolves
 * (resolveInstalledClaude) run with its OWN discovered login verb
 * (discoverLoginArgv) — never a request-supplied string. No request input
 * reaches the spawn.
 */

/* -------------------------------------------------------------------------- */
/* ANSI + URL extraction (pure, unit-testable)                                */
/* -------------------------------------------------------------------------- */

// Strip the escape sequences a pty emits (SGR color, cursor moves, OSC title
// sets) so a URL wrapped in color codes is still matchable. Two passes: OSC
// (ESC ] ... BEL|ST) then CSI / single-char CSI-less escapes.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_OSC = new RegExp(ESC + "\\][^" + ESC + BEL + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g");
const ANSI_CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const ANSI_OTHER = new RegExp(ESC + "[@-Z\\\\-_]", "g");

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
}

// Trailing chars that are punctuation/box-drawing wrapping a URL, not part of it.
function trimUrl(url: string): string {
  return url.replace(/[)\].,;'">`│─\s]+$/u, "");
}

/**
 * Lift the sign-in URL from (possibly ANSI-colored, wrapped) CLI output.
 * Deliberately tolerant because the exact wording moves across CLI versions:
 *   1. any claude.ai OAuth URL (…/oauth…), anywhere;
 *   2. any console.anthropic.com URL, anywhere;
 *   3. otherwise the first https URL on a line that invites the user to
 *      open / visit / sign in / paste it into a browser.
 * Returns null when no plausible auth URL is present yet.
 */
export function extractAuthUrl(raw: string): string | null {
  const text = stripAnsi(raw);

  const oauth = text.match(/https:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/[^\s'"<>`]*oauth[^\s'"<>`]*/i);
  if (oauth) return trimUrl(oauth[0]);
  const claudeOauthPath = text.match(/https:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/oauth[^\s'"<>`]*/i);
  if (claudeOauthPath) return trimUrl(claudeOauthPath[0]);

  const console_ = text.match(/https:\/\/console\.anthropic\.com\/[^\s'"<>`]*/i);
  if (console_) return trimUrl(console_[0]);

  for (const line of text.split(/\r?\n/)) {
    if (/\b(open|visit|sign[\s-]?in|browser|go to|navigate|paste|copy)\b/i.test(line)) {
      const m = line.match(/https:\/\/[^\s'"<>`]+/i);
      if (m) return trimUrl(m[0]);
    }
  }
  return null;
}

// Text the CLI prints once the browser round-trip completed. Belt to the
// authoritative claudeStatus() poll — either flips us to "done".
const SUCCESS_RE =
  /login successful|logged in successfully|successfully logged in|you(?:'re| are)? (?:now )?(?:logged|signed) in|authentication (?:complete|successful)|you are all set/i;

export function looksLikeLoginSuccess(raw: string): boolean {
  return SUCCESS_RE.test(stripAnsi(raw));
}

/* -------------------------------------------------------------------------- */
/* login state (extends Phase A's status JSON, additively)                    */
/* -------------------------------------------------------------------------- */

export type LoginPtyState =
  | "idle"
  | "starting"
  | "url-ready"
  | "waiting"
  | "done"
  | "failed";

export interface LoginStatus {
  state: LoginPtyState;
  /** The captured OAuth URL, present once state === "url-ready". */
  url?: string;
  /** Which driver is in control: the PTY driver, or the Phase A blind spawn we
   *  fell over to. The UI uses this to pick the fallback UX. */
  method?: "pty" | "blind";
}

let status: LoginStatus = { state: "idle" };

export function getLoginState(): LoginStatus {
  return { ...status };
}

/** Record that the Phase A blind spawn is now driving (a failover, or the
 *  synchronous fallback when the PTY path could not start). `spawned` false =
 *  even the blind spawn failed. Keeps the UI's method/state in sync. */
export function noteBlindSpawn(spawned: boolean): void {
  status = spawned
    ? { state: "waiting", method: "blind" }
    : { state: "failed", method: "blind" };
  if (spawned) startCompletionWatch({});
}

/** Test-only: clear login state + reap any active login + stop the watcher. */
export function _resetLoginState(): void {
  stopCompletionWatch();
  active?.cleanup();
  active = null;
  status = { state: "idle" };
}

/* -------------------------------------------------------------------------- */
/* the driver                                                                 */
/* -------------------------------------------------------------------------- */

const SCRIPT_BIN = "/usr/bin/script";
const EXPECT_BIN = "/usr/bin/expect";
const URL_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 600_000; // 10 min
const POLL_INTERVAL_MS = 3_000;

export interface StartPtyLoginOptions {
  /** Fall over to the Phase A blind spawn (no URL seen in time, or the PTY
   *  errored after spawning). Must itself open the browser. */
  onFailover?: () => void;
  /** Append to the support log. */
  log?: (line: string) => void;
  /** Test seams. */
  commandOverride?: string;
  argvOverride?: string[];
  scriptBin?: string;
  env?: NodeJS.ProcessEnv;
  urlTimeoutMs?: number;
  completionTimeoutMs?: number;
  pollIntervalMs?: number;
  statusCheck?: () => Promise<string>;
}

interface ActiveLogin {
  cleanup: () => void;
}

let active: ActiveLogin | null = null;

// The completion watcher (status poll + hard timeout) is shared by both the PTY
// path and a blind failover, so it lives at module scope keyed off `active`.
let completionPoll: ReturnType<typeof setInterval> | null = null;
let completionTimer: ReturnType<typeof setTimeout> | null = null;

function stopCompletionWatch(): void {
  if (completionPoll) {
    clearInterval(completionPoll);
    completionPoll = null;
  }
  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
}

/** Poll claudeStatus() until signed-in (→ done) or a hard timeout (→ failed).
 *  Used once a URL is shown (PTY) or a blind spawn opened the browser. */
function startCompletionWatch(opts: {
  statusCheck?: () => Promise<string>;
  completionTimeoutMs?: number;
  pollIntervalMs?: number;
  onDone?: () => void;
}): void {
  stopCompletionWatch();
  const check = opts.statusCheck ?? (() => claudeStatus());
  const poll = async () => {
    try {
      if ((await check()) === "signed-in") {
        stopCompletionWatch();
        status = { state: "done" };
        active?.cleanup();
        active = null;
        opts.onDone?.();
      }
    } catch {
      /* transient probe failure — keep polling */
    }
  };
  completionPoll = setInterval(poll, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  completionTimer = setTimeout(() => {
    stopCompletionWatch();
    if (status.state !== "done") {
      status = { state: "failed", method: status.method };
      active?.cleanup();
      active = null;
    }
  }, opts.completionTimeoutMs ?? COMPLETION_TIMEOUT_MS);
  // Fire one immediate probe so an already-signed-in state resolves fast.
  void poll();
}

function resolvePtyBin(override?: string): string | null {
  if (override) return fs.existsSync(override) ? override : null;
  if (fs.existsSync(SCRIPT_BIN)) return SCRIPT_BIN;
  if (fs.existsSync(EXPECT_BIN)) return EXPECT_BIN;
  return null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the `<ptyBin> ...` argv that runs `cmd argv...` under a pty. `script`
 *  takes the command after the file arg; `expect` needs a one-liner. */
function ptyInvocation(ptyBin: string, cmd: string, argv: string[]): string[] {
  if (ptyBin.includes("expect")) {
    const spawnLine = [cmd, ...argv].map(shQuote).join(" ");
    return ["-c", `set timeout -1; spawn ${spawnLine}; expect eof`];
  }
  // macOS `script` takes the command as trailing args:
  //   script -q /dev/null <cmd> <args...>
  // util-linux `script` (Linux CI) wants -c "cmd args" and the log file last:
  //   script -q -c "<cmd> <args...>" /dev/null
  // Without this, every PTY login test fails on Linux (spawned=false).
  if (process.platform === "linux") {
    const line = [cmd, ...argv].map(shQuote).join(" ");
    return ["-q", "-c", line, "/dev/null"];
  }
  return ["-q", "/dev/null", cmd, ...argv];
}

/**
 * Start the PTY-driven login. Resolves { spawned } as soon as the child is
 * launched (or could not be), mirroring Phase A's startLogin signature; the
 * URL capture, completion detection, timeouts, and reaping all run in the
 * background and surface through getLoginState(). Single-flight: a call while a
 * login is already in flight returns { spawned: true } without a second spawn.
 * Never throws.
 */
export async function startPtyLogin(
  opts: StartPtyLoginOptions = {}
): Promise<{ spawned: boolean }> {
  const log = opts.log ?? (() => {});

  // Single-flight: an in-flight login (starting / url-ready / waiting) owns the
  // flow; do not launch a second CLI under the same account.
  if (active && (status.state === "starting" || status.state === "url-ready" || status.state === "waiting")) {
    return { spawned: true };
  }

  const ptyBin = resolvePtyBin(opts.scriptBin);
  if (!ptyBin) {
    log(`\n[login-pty] no pty tool (script/expect) available — falling back to blind spawn\n`);
    return { spawned: false };
  }

  const cmd = opts.commandOverride ?? resolveInstalledClaude();
  if (!cmd) {
    log(`\n[login-pty] no claude binary resolved — cannot start login\n`);
    return { spawned: false };
  }
  const argv = opts.argvOverride ?? (await discoverLoginArgv(cmd));

  status = { state: "starting", method: "pty" };

  let child: ChildProcess;
  try {
    child = spawn(ptyBin, ptyInvocation(ptyBin, cmd, argv), {
      // Own process group so cleanup() can reap the tree with a single group
      // kill. macOS `script` gives the command its OWN pty session, so killing
      // script (the pty master owner) closes the master fd → the command's pty
      // session gets SIGHUP and dies (verified on macOS); no orphaned PTYs.
      // stdin MUST be /dev/null, not a pipe: `script` does tcgetattr() on its
      // stdin and aborts with "Operation not supported on socket" if it's a
      // pipe. The login flow reads no stdin (it drives the browser), so EOF is
      // fine.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });
  } catch (e) {
    log(`\n[login-pty] spawn failed: ${(e as Error).message} — falling back to blind spawn\n`);
    status = { state: "starting" };
    return { spawned: false };
  }

  // ----- background state machine -----
  let buffer = "";
  let urlEmitted = false;
  let terminal = false; // a terminal state (done/failed/failover) was reached

  let urlTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;

  const killTree = () => {
    if (killed) return;
    killed = true;
    const pid = child.pid;
    try {
      if (typeof pid === "number") process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  const cleanup = () => {
    // Mark this login terminal BEFORE reaping the child. killTree() sends a
    // SIGKILL whose `close` event fires asynchronously — often after a later
    // login (e.g. the next test's, or a fresh sign-in attempt) has already
    // taken over `active`. Without this flag that late `close` would run
    // finish() and null the *current* login's `active` (breaking single-flight)
    // or flip an already-signed-in login to "failed". Terminal here makes the
    // reaped child's own close handler no-op.
    terminal = true;
    if (urlTimer) {
      clearTimeout(urlTimer);
      urlTimer = null;
    }
    killTree();
  };
  active = { cleanup };

  const failover = (why: string) => {
    if (terminal) return;
    terminal = true;
    if (urlTimer) {
      clearTimeout(urlTimer);
      urlTimer = null;
    }
    log(`\n[login-pty] ${why} — failing over to blind spawn\n`);
    killTree();
    // Hand off to the Phase A blind spawn; it sets state to waiting/blind and
    // (via noteBlindSpawn) starts its own completion watch.
    if (opts.onFailover) {
      opts.onFailover();
    } else {
      noteBlindSpawn(false);
    }
  };

  const finish = (state: "done" | "failed") => {
    if (terminal) return;
    terminal = true;
    if (urlTimer) {
      clearTimeout(urlTimer);
      urlTimer = null;
    }
    stopCompletionWatch();
    status = state === "done" ? { state: "done" } : { state: "failed", method: "pty" };
    killTree();
    active = null;
  };

  urlTimer = setTimeout(() => {
    if (!urlEmitted && !terminal) failover(`no auth URL within ${Math.round((opts.urlTimeoutMs ?? URL_TIMEOUT_MS) / 1000)}s`);
  }, opts.urlTimeoutMs ?? URL_TIMEOUT_MS);

  const onChunk = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-16000);
    if (!urlEmitted && !terminal) {
      const url = extractAuthUrl(buffer);
      if (url) {
        urlEmitted = true;
        if (urlTimer) {
          clearTimeout(urlTimer);
          urlTimer = null;
        }
        status = { state: "url-ready", url, method: "pty" };
        log(`\n[login-pty] auth URL surfaced\n`);
        // Now wait for completion: poll the authoritative status, with a hard cap.
        startCompletionWatch({
          statusCheck: opts.statusCheck,
          completionTimeoutMs: opts.completionTimeoutMs,
          pollIntervalMs: opts.pollIntervalMs,
        });
      }
    }
    // Success text is an accelerator; the poll is authoritative.
    if (urlEmitted && !terminal && looksLikeLoginSuccess(buffer)) {
      void (async () => {
        const check = opts.statusCheck ?? (() => claudeStatus());
        try {
          if ((await check()) === "signed-in") finish("done");
        } catch {
          /* keep the poll running */
        }
      })();
    }
  };

  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("error", (e) => {
    failover(`pty child error: ${e.message}`);
  });

  child.on("close", () => {
    if (terminal) return;
    if (!urlEmitted) {
      // Exited before ever printing a URL (immediate-exit / crash) → the PTY
      // path did not deliver; hand off to the blind spawn.
      failover("pty child exited before an auth URL appeared");
      return;
    }
    // Exited AFTER showing the URL — most CLIs exit only once login completed.
    // Confirm via the authoritative status probe.
    void (async () => {
      const check = opts.statusCheck ?? (() => claudeStatus());
      try {
        finish((await check()) === "signed-in" ? "done" : "failed");
      } catch {
        finish("failed");
      }
    })();
  });

  log(`\n[login-pty] spawned ${ptyBin} for ${cmd} ${argv.join(" ")}\n`);
  return { spawned: true };
}
