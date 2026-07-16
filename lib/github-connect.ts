import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getUserConfig } from "./user-config.ts";
import { workspacePath } from "./workspace.ts";
import { scanTreeForSecrets, describeFindings, type SecretFinding } from "./secret-scan.ts";

/**
 * "Your GitHub" (Journey Stage 4) — the gh-CLI wrapper.
 *
 * The customer connects their GitHub account once through GitHub's own
 * device-code flow, then Vidi does the rest: it makes a private backup of their
 * memory and keeps it up to date. We never handle a password or a token in this
 * process's memory or hand one to the browser — `gh` owns its own credential
 * store (the system keychain), and we only ever read its status or ask it to
 * push.
 *
 * Everything here shells out to the bundled/installed `gh` binary (overridable
 * with GH_BIN for tests, matching lib/swarm-github.ts). Failures are mapped to
 * plain-language reasons a customer screen can show verbatim.
 */

/* -------------------------------------------------------------------------- */
/* gh binary + small exec helpers                                             */
/* -------------------------------------------------------------------------- */

function ghBin(): string {
  return process.env.GH_BIN || "gh";
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** set when the binary itself could not be spawned (ENOENT = gh not installed). */
  spawnError?: NodeJS.ErrnoException;
}

/** Run a command to completion, capturing output. Never rejects — a non-zero
 *  exit or a spawn failure comes back as data so callers branch on it instead of
 *  try/catch. */
function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const nodeErr = err as NodeJS.ErrnoException | null;
        if (nodeErr && (nodeErr.code === "ENOENT" || (nodeErr as any).errno === -2)) {
          resolve({ code: 127, stdout: "", stderr: "", spawnError: nodeErr });
          return;
        }
        const code = nodeErr && typeof (nodeErr as any).code === "number" ? (nodeErr as any).code : nodeErr ? 1 : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* status + verify                                                            */
/* -------------------------------------------------------------------------- */

export interface GhStatus {
  /** gh has a stored credential for github.com. */
  connected: boolean;
  /** the logged-in username, when connected. */
  login: string | null;
  /** true only when gh isn't installed at all (routes report which component
   *  should have installed it). */
  notInstalled?: boolean;
}

// gh 2.9x `gh auth status` prints, per host:
//   ✓ Logged in to github.com account <login> (keyring)
// Older/other builds put it on stderr, so we parse stdout+stderr combined and
// strip ANSI first. NO_COLOR is also set on the call to suppress colour.
const ANSI = /\x1b\[[0-9;]*m/g;
const LOGIN_RE = /account\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\b/i;

/** Local credential check only — NO network call (fast; used by the polling UI).
 *  connected := `gh auth status` exits 0. */
export async function status(): Promise<GhStatus> {
  const r = await run(ghBin(), ["auth", "status", "--hostname", "github.com"], { timeoutMs: 10_000 });
  if (r.spawnError) return { connected: false, login: null, notInstalled: true };
  const text = (r.stdout + "\n" + r.stderr).replace(ANSI, "");
  const connected = r.code === 0 && /Logged in to github\.com/i.test(text);
  const m = LOGIN_RE.exec(text);
  return { connected, login: connected && m ? m[1] : null };
}

/**
 * A real API round-trip: `gh api user` returns the login on stdout and exits
 * non-zero when the stored credential is missing, revoked, or the network is
 * down. This is what verify() uses so a token revoked AFTER connecting is
 * caught, not just presence of a keychain entry.
 */
export async function apiWhoAmI(): Promise<
  { ok: true; login: string } | { ok: false; reason: string; kind: GhFailureKind }
> {
  const r = await run(ghBin(), ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  if (r.spawnError) {
    return { ok: false, kind: "not-installed", reason: NOT_INSTALLED_MSG };
  }
  if (r.code === 0 && r.stdout.trim()) return { ok: true, login: r.stdout.trim() };
  return classifyFailure(r.stderr || r.stdout);
}

/* -------------------------------------------------------------------------- */
/* device-code flow                                                           */
/* -------------------------------------------------------------------------- */

export type GhFailureKind =
  | "not-installed"
  | "expired"
  | "wrong-account"
  | "denied"
  | "offline"
  | "rate-limited"
  | "unknown";

export type GhResult =
  | { ok: true; login: string }
  | { ok: false; reason: string; kind: GhFailureKind };

export interface DeviceFlow {
  /** The one-time code, shown BIG on the device-code screen. */
  userCode: string;
  /** The page the customer opens (github.com/login/device). */
  verificationUri: string;
  /** Resolves when gh finishes: ok once the customer authorises, else a plain
   *  reason (expired / denied / offline / …). */
  completion: Promise<GhResult>;
  /** Stop the underlying gh process — used when the UI mints a FRESH code (the
   *  old code and its poller are abandoned). */
  cancel(): void;
}

/** Shared customer-facing copy for a missing gh binary — the ONE place this
 *  sentence is written, imported everywhere else it's shown (routes, the
 *  journey step) so a copy fix here can't drift out of sync. */
export const NOT_INSTALLED_MSG =
  "The GitHub helper isn't set up on this computer yet. The Vidi installer should have added it. Reinstall it or ask for help, then try again.";

// Bound how long we'll wait for gh to print a parseable device code before we
// give up. Without this, a gh version/locale whose output matches neither
// CODE_RE nor the bare fallback leaves gh sitting on its stdin prompt forever
// and startDeviceFlow's promise never settles — the API route (and the
// device-code screen behind it) would hang indefinitely on a novice's
// machine instead of showing a failure branch. 30s is generous for gh's own
// (near-instant) device-code request to GitHub. Read at CALL time (like
// ghBin()) so a test can override it to something short instead of waiting
// out the real 30s.
function codeScrapeTimeoutMs(): number {
  const override = Number(process.env.VIDI_GH_DEVICE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30_000;
}

const DEVICE_URL_DEFAULT = "https://github.com/login/device";
// gh prints: "! First copy your one-time code: XXXX-XXXX"
const CODE_RE = /one-time code:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i;
const URL_RE = /(https?:\/\/\S*github\.com\/login\/device\S*)/i;
// Bare fallback: a code-shaped token anywhere on the captured stderr.
const CODE_BARE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/** Only one device flow is ever in flight (one machine, one human). Tracked so a
 *  fresh-code request can cancel the previous poller. */
let pendingChild: ChildProcess | null = null;

/** Map gh's failure text to a customer reason + a machine kind. */
function classifyFailure(raw: string): { ok: false; reason: string; kind: GhFailureKind } {
  const text = (raw || "").replace(ANSI, "").toLowerCase();
  if (/expired|timed out|timeout/.test(text)) {
    return {
      ok: false,
      kind: "expired",
      reason: "That code timed out before it was used. Get a fresh code and try again.",
    };
  }
  if (/access_denied|denied|cancell?ed/.test(text)) {
    return {
      ok: false,
      kind: "denied",
      reason: "The connection was declined on the GitHub page. Start again to try once more.",
    };
  }
  if (/rate.?limit|too many|429|slow_down/.test(text)) {
    return {
      ok: false,
      kind: "rate-limited",
      reason: "GitHub asked us to wait a moment. Please try again in a minute.",
    };
  }
  if (/network|dial|lookup|no such host|offline|connection refused|could not resolve|timeout while/.test(text)) {
    return {
      ok: false,
      kind: "offline",
      reason: "Couldn't reach GitHub. Check your internet connection and try again.",
    };
  }
  return {
    ok: false,
    kind: "unknown",
    reason: "The connection didn't finish. Please start again.",
  };
}

/**
 * Start GitHub's device-code flow through `gh`.
 *
 * gh's own UX is: it requests a device code from GitHub, prints
 * "First copy your one-time code: XXXX-XXXX" (and the verification URL) to
 * stderr, then WAITS for the user to press Enter before it opens a browser and
 * begins polling. We spawn it with:
 *   - a piped stderr we scrape for the code + URL (available immediately, before
 *     any Enter is needed),
 *   - a piped stdin we write a newline to as soon as we have the code, so gh
 *     advances into its polling loop,
 *   - BROWSER=true so gh's "open a browser" step is a no-op — OUR screen opens
 *     the page, and on a headless service there is no browser anyway,
 *   - NO_COLOR so the scraped text has no ANSI codes.
 *
 * Resolves as soon as the code is parsed (so the screen can show it). The gh
 * process stays alive polling GitHub; its exit resolves `completion`.
 *
 * NOTE: the caller MUST have checked status().connected === false first — gh,
 * when already logged in, prints an interactive "re-authenticate?" prompt
 * instead of a device code, which this parser is not built to answer.
 */
export function startDeviceFlow(scopes = "repo"): Promise<DeviceFlow> {
  // Abandon any previous in-flight flow first (fresh-code path).
  cancelPendingFlow();

  return new Promise<DeviceFlow>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        ghBin(),
        ["auth", "login", "--web", "--git-protocol", "https", "--scopes", scopes, "--hostname", "github.com"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, BROWSER: "true", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
        }
      );
    } catch (e) {
      reject(e);
      return;
    }
    pendingChild = child;

    let stderrBuf = "";
    let stdoutBuf = "";
    let resolvedCode = false;
    let advanced = false;

    // completion resolver — settled once, on child exit or spawn error.
    let settleCompletion!: (r: GhResult) => void;
    const completion = new Promise<GhResult>((res) => {
      settleCompletion = res;
    });

    // Bounded wait for a parseable code (see CODE_SCRAPE_TIMEOUT_MS above).
    // Cleared the moment a code is parsed or the child exits/errors first.
    const scrapeTimeout = setTimeout(() => {
      if (resolvedCode) return;
      const reason = "Couldn't get a connection code from GitHub. Please try again.";
      settleCompletion({ ok: false, kind: "unknown", reason });
      reject(new Error(reason));
      cancelPendingFlow(); // reaps the stuck child so it can't linger on stdin
    }, codeScrapeTimeoutMs());
    scrapeTimeout.unref?.(); // never keep the process alive on this timer alone

    const tryParseCode = () => {
      if (resolvedCode) return;
      const buf = (stderrBuf + "\n" + stdoutBuf).replace(ANSI, "");
      const codeMatch = CODE_RE.exec(buf) || CODE_BARE_RE.exec(buf);
      if (!codeMatch) return;
      const urlMatch = URL_RE.exec(buf);
      resolvedCode = true;
      clearTimeout(scrapeTimeout);
      const userCode = codeMatch[1];
      const verificationUri = urlMatch ? urlMatch[1] : DEVICE_URL_DEFAULT;

      // Advance gh past its "Press Enter to open" wait so it starts polling.
      if (!advanced) {
        advanced = true;
        try {
          child.stdin?.write("\n");
        } catch {
          /* if stdin is gone gh may have already advanced — harmless */
        }
      }

      resolve({
        userCode,
        verificationUri,
        completion,
        cancel: () => cancelPendingFlow(),
      });
    };

    child.stderr?.on("data", (d) => {
      stderrBuf += d.toString();
      tryParseCode();
    });
    child.stdout?.on("data", (d) => {
      stdoutBuf += d.toString();
      tryParseCode();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(scrapeTimeout);
      if (pendingChild === child) pendingChild = null;
      if (err.code === "ENOENT") {
        settleCompletion({ ok: false, kind: "not-installed", reason: NOT_INSTALLED_MSG });
        if (!resolvedCode) reject(new Error(NOT_INSTALLED_MSG));
        return;
      }
      settleCompletion(classifyFailure(err.message));
      if (!resolvedCode) reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(scrapeTimeout);
      if (pendingChild === child) pendingChild = null;
      if (code === 0) {
        // gh stored the credential; read back who we are.
        status().then((s) =>
          settleCompletion(
            s.login
              ? { ok: true, login: s.login }
              : { ok: true, login: "" }
          )
        );
      } else {
        settleCompletion(classifyFailure(stderrBuf + "\n" + stdoutBuf));
      }
      // If gh exited before we ever saw a code, surface the failure to start().
      if (!resolvedCode) {
        reject(new Error(classifyFailure(stderrBuf + "\n" + stdoutBuf).reason));
      }
    });
  });
}

/** Kill the in-flight device-flow gh process, if any. Idempotent. */
export function cancelPendingFlow(): void {
  if (pendingChild) {
    try {
      pendingChild.kill();
    } catch {
      /* already gone */
    }
    pendingChild = null;
  }
}

/* -------------------------------------------------------------------------- */
/* repo provisioning + the ONE push surface                                   */
/* -------------------------------------------------------------------------- */

/** Default backup repo name. Private, customer-owned; renamable by the caller. */
export const DEFAULT_WIKI_REPO = "my-vidi-memory";

/**
 * The backup repo carries the persona's name (2026-07-12 ruling): an install
 * named "Anna" backs up to my-anna-memory. The default persona keeps the
 * classic my-vidi-memory. Slug-safe; falls back to the classic name when the
 * persona doesn't slug to anything usable.
 */
export function personaWikiRepoName(): string {
  let persona = "";
  try {
    persona = getUserConfig().assistantName || "";
  } catch {
    /* default below */
  }
  const slug = persona
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `my-${slug}-memory` : DEFAULT_WIKI_REPO;
}

/** The local folder that holds the customer's memory (the wiki/brain dir). This
 *  is the ONLY folder pushWikiBackup ever pushes. */
export function wikiBackupPath(): string {
  return workspacePath(getUserConfig().brainDirName);
}

export interface RepoResult {
  ok: boolean;
  /** "<login>/<name>" when known. */
  fullName?: string;
  reason?: string;
  kind?: GhFailureKind;
}

/** git helper bound to a working dir. Never rejects (see run()). */
function git(cwd: string, args: string[]): Promise<ExecResult> {
  return run("git", args, { cwd, timeoutMs: 60_000 });
}

/**
 * Credential config that makes an https github.com git op use gh's stored
 * device-flow token EXPLICITLY, and only that:
 *   - the first (empty) value RESETS the helper chain for this host, so the
 *     system `credential.helper=osxkeychain` a fresh macOS account ships with
 *     can't shadow the token or block on an interactive prompt with no terminal;
 *   - the second routes to gh's credential bridge, which hands over the token gh
 *     already holds from the device-code connect.
 * Scoped per command (-c) so we never depend on a global `gh auth setup-git`
 * having run and never write to the customer's git config.
 */
function ghCredentialArgs(): string[] {
  return [
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    `credential.https://github.com.helper=!${ghBin()} auth git-credential`,
  ];
}

/** git for a NETWORK op (fetch/push): same as git() but with the explicit-token
 *  credential config prepended. */
function gitAuthed(cwd: string, args: string[]): Promise<ExecResult> {
  return git(cwd, [...ghCredentialArgs(), ...args]);
}

/**
 * Give the backup repo a repo-scoped git identity when the machine has none. A
 * fresh macOS standard account has no global user.name/user.email, so a plain
 * `git commit` would fail with "please tell me who you are" and the whole backup
 * would die before the push. We set a LOCAL identity (never global, never the
 * customer's config): the persona's name and a noreply email. If any identity
 * already resolves (global or local), we leave it alone.
 */
async function ensureLocalIdentity(cwd: string): Promise<void> {
  const email = await git(cwd, ["config", "user.email"]);
  if (email.code === 0 && email.stdout.trim()) return;
  let persona = "Vidi";
  try {
    persona = getUserConfig().assistantName || "Vidi";
  } catch {
    /* brand default */
  }
  const slug =
    persona.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "vidi";
  await git(cwd, ["config", "user.name", persona]);
  await git(cwd, ["config", "user.email", `${slug}-backup@users.noreply.github.com`]);
}

/**
 * Map a git/gh BACKUP failure to plain customer words. Deliberately SEPARATE from
 * classifyFailure(), whose "unknown" copy is "The connection didn't finish.
 * Please start again." — a sentence that is a lie after a successful connect. A
 * failed first push or repo step is a BACKUP problem, and its copy must say so.
 */
function classifyBackupFailure(raw: string): { reason: string; kind: GhFailureKind } {
  const text = (raw || "").replace(ANSI, "").toLowerCase();
  if (/rate.?limit|too many|429|slow_down/.test(text)) {
    return {
      kind: "rate-limited",
      reason:
        "GitHub asked us to wait a moment before saving your backup. Please try again in a minute.",
    };
  }
  if (/network|dial|lookup|no such host|offline|connection refused|could not resolve|timeout|timed out/.test(text)) {
    return {
      kind: "offline",
      reason: "Couldn't reach GitHub to save your backup. Check your internet connection and try again.",
    };
  }
  if (/could not read (username|password)|authentication failed|terminal prompts disabled|permission denied|403|401|bad credentials|access denied|invalid username or password/.test(text)) {
    return {
      kind: "denied",
      reason:
        "Vidi couldn't sign in to GitHub to save your backup. Open Your GitHub again and reconnect your account, then try once more.",
    };
  }
  return {
    kind: "unknown",
    reason: "Vidi couldn't save your backup just now. Please try again in a moment.",
  };
}

/**
 * Make sure a private backup repo exists for this account, idempotently. Creates
 * `<login>/<name>` with the default branch `main` if it isn't there; reuses it
 * if it is. Does NOT push — provisioning only (pushWikiBackup owns every push).
 */
export async function ensureWikiBackupRepo(
  login: string,
  name?: string
): Promise<RepoResult> {
  // No explicit name: prefer the persona-named repo, but REUSE an existing
  // repo under either name — a persona renamed after the first backup must
  // never fork a second orphaned backup repo.
  const candidates = name
    ? [name]
    : [...new Set([personaWikiRepoName(), DEFAULT_WIKI_REPO])];
  for (const candidate of candidates) {
    const fullName = `${login}/${candidate}`;
    const view = await run(ghBin(), ["repo", "view", fullName, "--json", "name"], { timeoutMs: 15_000 });
    if (view.spawnError) return { ok: false, reason: NOT_INSTALLED_MSG, kind: "not-installed" };
    if (view.code === 0) return { ok: true, fullName };
  }

  const createName = candidates[0];
  const fullName = `${login}/${createName}`;
  let persona = "Vidi";
  try {
    persona = getUserConfig().assistantName || "Vidi";
  } catch {
    /* brand default */
  }
  const create = await run(
    ghBin(),
    ["repo", "create", fullName, "--private", "--description", `My private ${persona} memory backup`],
    { timeoutMs: 30_000 }
  );
  if (create.spawnError) return { ok: false, reason: NOT_INSTALLED_MSG, kind: "not-installed" };
  if (create.code === 0 || /already exists/i.test(create.stderr)) return { ok: true, fullName };
  const f = classifyBackupFailure(create.stderr || create.stdout);
  return { ok: false, reason: f.reason, kind: f.kind };
}

/**
 * Provision a private per-project repo `<login>/<name>` (Journey Stage 6 uses
 * this). Idempotent, provisioning only — like ensureWikiBackupRepo it NEVER
 * pushes. Vidi's project work happens on branches through the agent session,
 * which is push-protected against main by lib/providers/claude.ts.
 */
export async function ensureProjectRepo(login: string, name: string): Promise<RepoResult> {
  const fullName = `${login}/${name}`;
  const view = await run(ghBin(), ["repo", "view", fullName, "--json", "name"], { timeoutMs: 15_000 });
  if (view.spawnError) return { ok: false, reason: NOT_INSTALLED_MSG, kind: "not-installed" };
  if (view.code === 0) return { ok: true, fullName };
  const create = await run(
    ghBin(),
    ["repo", "create", fullName, "--private", "--description", `Vidi project: ${name}`],
    { timeoutMs: 30_000 }
  );
  if (create.spawnError) return { ok: false, reason: NOT_INSTALLED_MSG, kind: "not-installed" };
  if (create.code === 0 || /already exists/i.test(create.stderr)) return { ok: true, fullName };
  const f = classifyFailure(create.stderr || create.stdout);
  return { ok: false, reason: f.reason, kind: f.kind };
}

export interface PushResult {
  ok: boolean;
  /** plain-language outcome for the customer. */
  reason?: string;
  /** populated (and ok=false) when the secret gate blocked the push. */
  secrets?: SecretFinding[];
  kind?: GhFailureKind | "secret-blocked";
}

/**
 * ============================================================================
 * pushWikiBackup — THE ONLY DIRECT-PUSH SURFACE IN THIS MODULE.
 * ============================================================================
 *
 * It pushes exactly one thing: the customer's memory folder, to their private
 * backup repo, on `main`. No other function here runs `git push`. This is
 * asserted by tests/github-push-discipline.test.ts, which scans this source and
 * fails if a `git push` ever appears outside this function or targets anything
 * but the `backup` remote. Do NOT add another push path here — Vidi's project
 * work pushes to BRANCHES through the agent session, never directly, and that
 * separation is what keeps main protected.
 *
 * MANDATORY: the secret gate (scanTreeForSecrets) runs FIRST. If any outgoing
 * file looks like it holds a credential the push is BLOCKED and the file+line is
 * returned in customer words — nothing leaves the machine.
 */
export async function pushWikiBackup(
  wikiPath: string = wikiBackupPath(),
  fullName?: string
): Promise<PushResult> {
  if (!existsSync(wikiPath)) {
    return { ok: false, reason: "There's nothing to back up yet.", kind: "unknown" };
  }

  // 1) MANDATORY pre-push secret gate.
  const findings = scanTreeForSecrets(wikiPath);
  if (findings.length > 0) {
    return {
      ok: false,
      secrets: findings,
      kind: "secret-blocked",
      reason: describeFindings(findings),
    };
  }

  // 2) Resolve the destination repo if the caller didn't name one.
  let dest = fullName;
  if (!dest) {
    const who = await status();
    if (!who.connected || !who.login) {
      return { ok: false, reason: "Connect your GitHub account first.", kind: "denied" };
    }
    const repo = await ensureWikiBackupRepo(who.login);
    if (!repo.ok || !repo.fullName) return { ok: false, reason: repo.reason, kind: repo.kind };
    dest = repo.fullName;
  }
  const remoteUrl = `https://github.com/${dest}.git`;

  // 3) Make sure git uses gh's stored credential over https for any git op that
  //    inherits the global config (project flows). The push/fetch below ALSO
  //    pass the token explicitly per command (gitAuthed), so the backup no longer
  //    depends on this global setup having taken effect.
  await run(ghBin(), ["auth", "setup-git", "--hostname", "github.com"], { timeoutMs: 15_000 });

  // 4) Init + main branch + remote + a repo-scoped identity, idempotently.
  if (!existsSync(path.join(wikiPath, ".git"))) {
    const init = await git(wikiPath, ["init"]);
    if (init.code !== 0) return { ok: false, reason: gitReason(init), kind: "unknown" };
  }
  await ensureLocalIdentity(wikiPath); // fresh account has no global git user
  await git(wikiPath, ["branch", "-M", "main"]); // default branch = main
  const remote = await git(wikiPath, ["remote", "get-url", "backup"]);
  if (remote.code !== 0) {
    const add = await git(wikiPath, ["remote", "add", "backup", remoteUrl]);
    if (add.code !== 0) return { ok: false, reason: gitReason(add), kind: "unknown" };
  } else if (remote.stdout.trim() !== remoteUrl) {
    await git(wikiPath, ["remote", "set-url", "backup", remoteUrl]);
  }

  // 5) Stage + commit (skip cleanly when there's nothing new).
  await git(wikiPath, ["add", "-A"]);
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const commit = await git(wikiPath, ["commit", "-m", `Vidi backup ${stamp}`]);
  const nothingToCommit = /nothing to commit|no changes added/i.test(commit.stdout + commit.stderr);

  // 6) Reconcile with any history the backup repo already has. A brand-new local
  //    repo pushing to a repo that already carries commits (e.g. one reused from
  //    earlier testing) is a non-fast-forward reject. We NEVER force over their
  //    data: rebase this snapshot on top of the existing history when that is
  //    clean, and when the histories genuinely conflict, land the snapshot on a
  //    fresh dated branch and leave the existing backup untouched.
  let pushRef = "main";
  let divergedBranch: string | null = null;
  await gitAuthed(wikiPath, ["fetch", "backup", "main"]); // no-op/err on an empty repo; ignored
  const hasRemoteMain =
    (await git(wikiPath, ["rev-parse", "--verify", "--quiet", "backup/main"])).code === 0;
  if (hasRemoteMain) {
    const rebase = await git(wikiPath, ["rebase", "backup/main"]);
    if (rebase.code !== 0) {
      await git(wikiPath, ["rebase", "--abort"]);
      divergedBranch = `vidi-backup-${stamp.replace(/[: ]/g, "-")}`;
      pushRef = `HEAD:${divergedBranch}`;
    }
  }

  // 7) THE push — backup remote only, never forced.
  const push = await gitAuthed(wikiPath, ["push", "-u", "backup", pushRef]);
  if (push.spawnError) return { ok: false, reason: "Couldn't run the backup just now.", kind: "unknown" };
  if (push.code !== 0) {
    const both = push.stderr + push.stdout;
    // "up to date" is success when there was nothing to commit.
    if (nothingToCommit && /up.to.date|everything up-to-date/i.test(both)) {
      return { ok: true, reason: "Your memory is already backed up." };
    }
    if (/\brejected\b|non-fast-forward|fetch first|tip of your current branch is behind/i.test(both)) {
      return {
        ok: false,
        kind: "unknown",
        reason:
          "This GitHub account already holds a different backup, so Vidi did not overwrite it. Reconnect the GitHub account you want to use for backups, then try again.",
      };
    }
    const f = classifyBackupFailure(push.stderr);
    return { ok: false, reason: f.reason, kind: f.kind };
  }
  if (divergedBranch) {
    return {
      ok: true,
      reason: `This GitHub account already had a different backup, so Vidi saved your memory to a separate backup named "${divergedBranch}" and left the existing one untouched.`,
    };
  }
  return { ok: true, reason: "Your memory is now backed up." };
}

function gitReason(r: ExecResult): string {
  const f = classifyBackupFailure(r.stderr || r.stdout);
  return f.reason;
}
