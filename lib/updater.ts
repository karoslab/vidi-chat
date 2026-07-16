import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dataPath } from "./data-dir.ts";
import { readProxyKey } from "./proxy-secret.ts";
import { WORKER_BASE } from "./worker-url.ts";
import {
  isDevBuild,
  readReleaseInfo,
  updateForced,
  type ReleaseInfo,
} from "./release.ts";

/**
 * Over-the-air self-updater (release-channel client).
 *
 * The channel is the existing vidi-proxy worker. Authentication reuses the
 * install's `.proxy-secret` (x-vidi-key header) — the SAME credential TTS uses
 * (lib/proxy-secret.ts). Contract:
 *   GET {WORKER_BASE}/release/manifest → { version, sha, url, sha256, notes }
 *   GET manifest.url                   → a .tar.gz of the vidi-chat source tree
 *
 * applyUpdate() never rebuilds in place (that deadlocks a running `next start`
 * whose dist dir is swapped under it — see lib/origin.ts / the two 2026-07-06
 * incidents). It downloads, verifies the pinned sha256, unpacks to a STAGING
 * sibling dir, runs npm ci + `next build` (NEXT_DIST_DIR=.next-build, the same
 * contract the launchd service uses) IN staging, then atomically renames the
 * live dir aside (.prev-<version>, kept for rollback) and staging into place,
 * and exits so launchd KeepAlive respawns on the new code.
 *
 * This module is written for injection: fetch, the subprocess runner, and the
 * exit hook are all overridable so tests never touch the network, spawn a
 * process, or kill the runner.
 */

// Manifest + download live under /release on the worker (lib/worker-url.ts).
export { WORKER_BASE };
export const MANIFEST_URL = `${WORKER_BASE}/release/manifest`;

// npm ci + next build + the tarball need real headroom on an older Mac.
export const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB
const STALE_LOCK_MS = 60 * 60 * 1000; // reclaim a lock older than an hour

export interface UpdateManifest {
  version: string;
  sha: string;
  url: string;
  sha256: string;
  notes: string;
}

export interface UpdateCheckResult {
  available: boolean;
  current: { version: string; sha: string };
  latest?: { version: string; sha: string };
  notes?: string;
  devBuild?: boolean;
  error?: string;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "unpacking"
  | "installing"
  | "building"
  | "swapping"
  | "done"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  pct?: number;
  logTail: string;
  done: boolean;
  ok: boolean;
  error?: string;
  version?: string;
  startedAt?: number;
}

// ── on-disk locations (all in the data dir → OUTSIDE the app dir, so the swap
//    never touches them; resolved lazily so tests that chdir/isolate are honored)
function statusFile(): string {
  return dataPath("update-status.json");
}
function logFile(): string {
  return dataPath("update.log");
}
function lockFile(): string {
  return dataPath("update.lock");
}

// ── manifest parsing + compare ──────────────────────────────────────────────

export function parseManifest(raw: unknown): UpdateManifest {
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("manifest is not an object");
  const str = (k: keyof UpdateManifest): string => {
    const v = j[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`manifest.${String(k)} missing`);
    return v.trim();
  };
  return {
    version: str("version"),
    sha: str("sha"),
    url: str("url"),
    sha256: str("sha256").toLowerCase(),
    notes: typeof j.notes === "string" ? j.notes : "",
  };
}

/**
 * Is the channel offering something other than what we run? A differing sha is
 * the authoritative "different code" signal (version is a human label); either
 * differing means an update is available. Dev builds are gated out earlier by
 * the caller (they have no sha, so everything would look "available").
 */
export function isUpdateAvailable(current: ReleaseInfo, latest: UpdateManifest): boolean {
  if (!latest || !latest.version) return false;
  // When both sides carry a git sha it is authoritative: identical sha means
  // identical code, so a bumped version LABEL alone is not an update (and we
  // avoid reinstalling the same bytes). Differing sha → update.
  if (latest.sha && current.sha) return latest.sha !== current.sha;
  // A dev build (or a manifest without a sha) falls back to the version label.
  return latest.version !== current.version;
}

// ── integrity ───────────────────────────────────────────────────────────────

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function verifySha256(buf: Buffer | Uint8Array, expectedHex: string): boolean {
  const expected = (expectedHex || "").trim().toLowerCase();
  return !!expected && sha256Hex(buf) === expected;
}

// ── path resolution ─────────────────────────────────────────────────────────

export interface UpdatePaths {
  appDir: string;
  stagingDir: string;
  downloadFile: string;
  nodeBin: string;
  npmCli: string;
  nextBinStaging: string;
  dataInsideApp: boolean;
}

function safeVersion(version: string): string {
  return version.replace(/[^0-9A-Za-z._-]/g, "_") || "unknown";
}

/** child is contained within parent (used to decide whether to carry data/). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve every path the swap needs.
 *   appDir   = the live checkout (launchd WorkingDirectory = process.cwd()).
 *   nodeBin  = the running node (process.execPath) — the bundled runtime.
 *   npmCli   = <runtime>/lib/node_modules/npm/bin/npm-cli.js, exactly where the
 *              launcher's NPM_CLI resolves (common.sh).
 */
export function resolveUpdatePaths(
  version: string,
  appDir: string = process.cwd(),
  dataDirPath: string = dataPath(),
  nodeBin: string = process.execPath,
): UpdatePaths {
  const safe = safeVersion(version);
  const stagingDir = `${appDir}.staging-${safe}`;
  const nodeRoot = path.dirname(path.dirname(nodeBin)); // <runtime>/node/bin/node → <runtime>/node
  return {
    appDir,
    stagingDir,
    downloadFile: `${appDir}.download-${safe}.tar.gz`,
    nodeBin,
    npmCli: path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    nextBinStaging: path.join(stagingDir, "node_modules", "next", "dist", "bin", "next"),
    // dataPath() with no args → the data dir itself; carry it only if it lives
    // inside the app dir. On a real customer install VIDI_DATA_DIR points OUTSIDE
    // the app dir, so this is false and the swap is a clean two-rename dance.
    dataInsideApp: isInside(appDir, dataDirPath),
  };
}

// ── the atomic swap ─────────────────────────────────────────────────────────

/**
 * Rename the live dir aside and staging into place. If the app's data/ lives
 * INSIDE the app dir (carryData), move it into staging first so the new tree
 * keeps the user's data. Both dirs must be on the same filesystem (they are —
 * staging is a sibling of appDir) so rename is atomic. On a failure renaming
 * staging in, the old dir is rolled back so the service still starts.
 * Returns the kept .prev-<version> dir (manual rollback via Helper Repair).
 */
export function atomicSwap(opts: {
  appDir: string;
  stagingDir: string;
  version: string;
  carryData?: boolean;
  fsMod?: typeof fs;
}): { prevDir: string } {
  const f = opts.fsMod ?? fs;
  const prevDir = `${opts.appDir}.prev-${safeVersion(opts.version)}`;

  if (opts.carryData) {
    const src = path.join(opts.appDir, "data");
    const dst = path.join(opts.stagingDir, "data");
    if (f.existsSync(src)) {
      f.rmSync(dst, { recursive: true, force: true });
      f.renameSync(src, dst);
    }
  }

  // Clear a stale prev dir left by an earlier update of the same version.
  f.rmSync(prevDir, { recursive: true, force: true });
  f.renameSync(opts.appDir, prevDir);
  try {
    f.renameSync(opts.stagingDir, opts.appDir);
  } catch (e) {
    // Roll back so the service still has a working app dir to restart into.
    try {
      f.renameSync(prevDir, opts.appDir);
    } catch {
      /* nothing more we can safely do; surface the original error */
    }
    throw e;
  }
  return { prevDir };
}

// ── subprocess runner (npm ci / next build / tar) ───────────────────────────

export type Runner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<void>;

/** The exact env the launchd service builds with (NEXT_DIST_DIR=.next-build). */
export function stagingBuildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, NODE_ENV: "production", NEXT_DIST_DIR: ".next-build" };
}

export async function npmCiStaging(p: UpdatePaths, run: Runner): Promise<void> {
  // --include=dev: the live service runs with NODE_ENV=production (next start
  // sets it), which npm would inherit and omit typescript/@types — leaving
  // `next build` to auto-install the TS toolchain over the network mid-build.
  // Staged deps must be deterministic and offline-complete before the build.
  await run(p.nodeBin, [p.npmCli, "ci", "--no-audit", "--no-fund", "--include=dev"], {
    cwd: p.stagingDir,
    env: { ...process.env },
  });
}

export async function buildStaging(p: UpdatePaths, run: Runner): Promise<void> {
  await run(p.nodeBin, [p.nextBinStaging, "build"], {
    cwd: p.stagingDir,
    env: stagingBuildEnv(),
  });
}

const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const cap = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      appendLog(s.trimEnd());
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(cmd)} ${args[0] ?? ""} exited ${code}\n${tail.slice(-400)}`)),
    );
  });

// ── disk-space sanity ───────────────────────────────────────────────────────

export function freeBytes(dir: string = process.cwd()): number {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    // If we cannot measure, do not block the update on a phantom low-disk.
    return Number.MAX_SAFE_INTEGER;
  }
}

// ── status + append-only log ────────────────────────────────────────────────

let memStatus: UpdateStatus = { phase: "idle", logTail: "", done: false, ok: false };

function writeStatusFile(): void {
  try {
    fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify(memStatus));
  } catch {
    /* best-effort: the in-memory status is the primary; the file is for
       surviving the restart at the end of a successful update */
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  memStatus = { ...memStatus, ...patch };
  writeStatusFile();
}

function appendLog(line: string): void {
  if (!line) return;
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), stamped);
  } catch {
    /* best-effort */
  }
  memStatus = { ...memStatus, logTail: (memStatus.logTail + stamped).slice(-4000) };
  writeStatusFile();
}

/**
 * The current status. In-memory while an update runs; after the process exits
 * and launchd respawns on the new code, the fresh process reports idle — so we
 * fall back to the persisted status file (which lives in the data dir and
 * survives the swap) so the UI can still show "done" right after the restart.
 */
export function getStatus(): UpdateStatus {
  if (memStatus.phase !== "idle") return memStatus;
  try {
    const j = JSON.parse(fs.readFileSync(statusFile(), "utf8"));
    if (j && typeof j.phase === "string") return j as UpdateStatus;
  } catch {
    /* no persisted status → idle */
  }
  return memStatus;
}

// ── single-flight lock ──────────────────────────────────────────────────────

let running = false;

/** Exported for the single-flight test; also used internally by startUpdate. */
export function acquireUpdateLock(): boolean {
  if (running) return false;
  try {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    const fd = fs.openSync(lockFile(), "wx"); // O_EXCL → fails if it exists
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
  } catch {
    // A lock exists. Reclaim it if it is stale (a prior run that died without
    // releasing), otherwise refuse — an update is genuinely in flight.
    try {
      const st = fs.statSync(lockFile());
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
        fs.rmSync(lockFile(), { force: true });
        return acquireUpdateLock();
      }
    } catch {
      /* the lock vanished between open and stat — fall through to refuse */
    }
    return false;
  }
  running = true;
  return true;
}

export function releaseUpdateLock(): void {
  running = false;
  try {
    fs.rmSync(lockFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

// ── check ───────────────────────────────────────────────────────────────────

export async function checkForUpdate(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<UpdateCheckResult> {
  const info = readReleaseInfo();
  const current = { version: info.version, sha: info.sha };
  if (isDevBuild(info) && !updateForced()) {
    return { available: false, current, devBuild: true };
  }
  const key = readProxyKey();
  if (!key) {
    return { available: false, current, error: "Updates need your Vidi code. Enter it in Settings, Voice tab, then check again." };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(MANIFEST_URL, {
      headers: { "x-vidi-key": key },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { available: false, current, error: "Could not reach the update service. Check your internet and try again." };
  }
  if (!res.ok) {
    return { available: false, current, error: `The update service answered ${res.status}.` };
  }
  let manifest: UpdateManifest;
  try {
    manifest = parseManifest(await res.json());
  } catch {
    return { available: false, current, error: "The update service sent something we did not understand." };
  }
  return {
    available: isUpdateAvailable(info, manifest),
    current,
    latest: { version: manifest.version, sha: manifest.sha },
    notes: manifest.notes,
  };
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface StartOptions {
  fetchImpl?: typeof fetch;
  run?: Runner;
  exit?: (code: number) => void;
  /** Delay before the exit-to-restart (ms). Default 1500 so a final client poll
   *  can see "done"; tests pass 0. */
  restartDelayMs?: number;
}

function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Surface our own plain-language messages verbatim; anything else gets a
  // generic line (the raw detail is already in update.log).
  if (/^[A-Z].*\.$/.test(msg) && msg.length < 200) return msg;
  return "The update could not finish. Your current version is untouched. Please try again.";
}

/**
 * Kick off an update in the background and return immediately. The client polls
 * getStatus() (GET /api/update/status). Single-flight: a second call while one
 * is running returns { started:false }.
 */
export function startUpdate(opts: StartOptions = {}): { started: boolean; error?: string } {
  if (!acquireUpdateLock()) {
    return { started: false, error: "An update is already running." };
  }
  memStatus = { phase: "checking", logTail: "", done: false, ok: false, startedAt: Date.now() };
  writeStatusFile();
  runUpdatePipeline(opts)
    .catch((e) => {
      appendLog(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      setStatus({ phase: "error", done: true, ok: false, error: humanError(e) });
    })
    .finally(() => releaseUpdateLock());
  return { started: true };
}

/**
 * The full update pipeline. Exported (rather than kept private) so tests can
 * await it directly with injected fetch/run/exit — startUpdate() runs it
 * fire-and-forget behind the single-flight lock for the route.
 */
export async function runUpdatePipeline(opts: StartOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const run = opts.run ?? defaultRunner;
  const exit = opts.exit ?? ((c: number) => process.exit(c));

  appendLog("update started");
  setStatus({ phase: "checking" });

  const info = readReleaseInfo();
  if (isDevBuild(info) && !updateForced()) {
    throw new Error("This is a development build. Updates are disabled here.");
  }
  const key = readProxyKey();
  if (!key) throw new Error("Updates need your Vidi code. Enter it in Settings, Voice tab, then check again.");

  // 1. manifest
  const mres = await doFetch(MANIFEST_URL, {
    headers: { "x-vidi-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!mres.ok) throw new Error(`The update service answered ${mres.status}.`);
  const manifest = parseManifest(await mres.json());
  if (!isUpdateAvailable(info, manifest)) {
    appendLog("already up to date");
    setStatus({ phase: "done", done: true, ok: true, version: manifest.version });
    return;
  }

  const paths = resolveUpdatePaths(manifest.version);
  setStatus({ version: manifest.version });

  // 2. disk sanity BEFORE download
  const free = freeBytes(paths.appDir);
  if (free < MIN_FREE_BYTES) {
    throw new Error("There is not enough free disk space to update. Free up a few gigabytes and try again.");
  }

  // Clean any leftovers from a previously-failed run.
  fs.rmSync(paths.stagingDir, { recursive: true, force: true });
  fs.rmSync(paths.downloadFile, { force: true });

  // 3. download
  // Pin the download to the release channel's origin: the pinned sha256
  // protects the downloaded CONTENT, but the install key must never be sent
  // to a host the manifest names outside our worker.
  if (new URL(manifest.url).origin !== new URL(WORKER_BASE).origin) {
    throw new Error("Update manifest points outside the release channel.");
  }
  setStatus({ phase: "downloading", pct: 0 });
  const dres = await doFetch(manifest.url, {
    headers: { "x-vidi-key": key },
    signal: AbortSignal.timeout(180_000),
  });
  if (!dres.ok) throw new Error(`Download failed (${dres.status}).`);
  const buf = Buffer.from(await dres.arrayBuffer());
  fs.writeFileSync(paths.downloadFile, buf);
  appendLog(`downloaded ${buf.length} bytes`);

  // 4. verify pinned sha256 — reject a mismatch HARD (nothing gets unpacked)
  setStatus({ phase: "verifying" });
  if (!verifySha256(buf, manifest.sha256)) {
    fs.rmSync(paths.downloadFile, { force: true });
    throw new Error("The downloaded update did not match its checksum, so it was thrown away. Nothing on your Mac was changed.");
  }
  appendLog("checksum verified");

  // 5. unpack to staging (git archive tarball → --strip-components=1)
  setStatus({ phase: "unpacking" });
  fs.mkdirSync(paths.stagingDir, { recursive: true });
  await run("tar", ["-xzf", paths.downloadFile, "-C", paths.stagingDir, "--strip-components=1"], {
    cwd: path.dirname(paths.stagingDir),
    env: { ...process.env },
  });
  fs.rmSync(paths.downloadFile, { force: true });
  appendLog("unpacked to staging");

  // 6. npm ci in staging
  setStatus({ phase: "installing" });
  await npmCiStaging(paths, run);
  appendLog("dependencies installed");

  // 7. next build in staging (same dist-dir/env as the service)
  setStatus({ phase: "building" });
  await buildStaging(paths, run);
  if (!fs.existsSync(path.join(paths.stagingDir, ".next-build", "BUILD_ID"))) {
    throw new Error("The new version did not build correctly. Your current version is untouched.");
  }
  appendLog("built .next-build in staging");

  // 8. atomic swap (carry an in-app data dir if that is where it lives)
  setStatus({ phase: "swapping" });
  const { prevDir } = atomicSwap({
    appDir: paths.appDir,
    stagingDir: paths.stagingDir,
    version: manifest.version,
    carryData: paths.dataInsideApp,
  });
  appendLog(`swapped into place; previous version kept at ${prevDir}`);

  // 9. done → exit so launchd KeepAlive respawns on the new code. Persist the
  //    done status first (it lives in the data dir, survives the restart) and
  //    delay the exit briefly so the client's next poll sees "done".
  setStatus({ phase: "done", done: true, ok: true, version: manifest.version });
  appendLog("update complete; restarting");
  setTimeout(() => exit(0), opts.restartDelayMs ?? 1500);
}
