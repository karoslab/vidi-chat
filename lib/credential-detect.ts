import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getUserConfig } from "./user-config.ts";

/**
 * Credential auto-detect + live-test (T2.1 — the OpenClaw "single best pattern").
 *
 * First-run step 0 verifies, server-side, that the backends the app spawns
 * (the claude Max CLI and the codex ChatGPT CLI) are actually installed AND
 * logged in — so a non-owner second user sees a green check per working backend
 * and only picks one that's real, instead of hitting a raw stderr wall on her
 * first turn. She NEVER sees a raw API-key field: if nothing verifies she gets
 * plain-language "log in via the CLI" instructions and a re-check button.
 *
 * SECURITY (binds every executor — anti-pattern #2/#5): the binary path is
 * resolved ONLY from the trusted user-config seam (getUserConfig().claudeBin,
 * the CLAUDE_BIN/CODEX_BIN env vars) or a PATH lookup. A path string from the
 * HTTP request is NEVER executed — the route passes no user input into here.
 *
 * COST: the liveness probe is a cheap auth-status subcommand, never a model
 * call — `claude auth status` (JSON with loggedIn) and `codex login status`
 * both return in well under a second and burn zero tokens. Each probe has a
 * hard timeout; a failure is a friendly "not connected" state, never an
 * exception (the whole surface is wrapped so onboarding can never crash on it).
 */

/** Per-probe hard timeout. The status subcommands return in <250ms locally;
 *  5s is generous headroom for a cold spawn / slow disk without ever hanging
 *  the onboarding step. */
export const PROBE_TIMEOUT_MS = 5000;

export type BackendId = "claude" | "codex";

export interface BackendStatus {
  id: BackendId;
  /** How Vidi names this backend in the picker. */
  label: string;
  /** The binary was found (configured path exists, or it's on PATH). */
  installed: boolean;
  /** The install is logged in — a turn would actually run. Only a verified
   *  backend is selectable in the UI. */
  loggedIn: boolean;
  /** Plain-language next step when this backend isn't ready (install / log in).
   *  null when it's verified. Safe to show the user verbatim — never raw stderr. */
  hint: string | null;
}

/** The raw outcome of running a status subcommand, kept separate from the
 *  interpretation so the classifier below is pure and unit-testable. */
export interface ProbeResult {
  /** The binary could be spawned at all (false = ENOENT / not installed). */
  spawned: boolean;
  /** Process exit code (null = killed by the timeout or a signal). */
  exitCode: number | null;
  /** Combined stdout+stderr, already truncated. For classification + logging —
   *  NEVER surfaced to the user. */
  output: string;
}

/**
 * Pure interpretation of a status-subcommand run into a logged-in verdict. No
 * I/O — unit-tested. Recognizes the two CLIs' "logged in" signals:
 *   - claude auth status → JSON `{"loggedIn": true, …}` on exit 0
 *   - codex login status → "Logged in using ChatGPT" on exit 0
 * A non-spawn (ENOENT) is not-installed; a clean exit whose output denies login
 * ("not logged in", `"loggedIn": false`) is installed-but-signed-out; anything
 * ambiguous is treated as NOT logged in (fail-safe — never offer a backend we
 * couldn't positively confirm).
 */
export function interpretProbe(id: BackendId, result: ProbeResult): {
  installed: boolean;
  loggedIn: boolean;
} {
  if (!result.spawned) return { installed: false, loggedIn: false };
  const lower = result.output.toLowerCase();

  // Explicit negatives always win, even on exit 0, so a "signed out" status
  // that still returns 0 can't be misread as logged in.
  const deniesLogin =
    lower.includes('"loggedin": false') ||
    lower.includes('"loggedin":false') ||
    lower.includes("not logged in") ||
    lower.includes("not signed in") ||
    lower.includes("logged out") ||
    lower.includes("please run") ||
    lower.includes("/login");
  if (deniesLogin) return { installed: true, loggedIn: false };

  const affirmsLogin =
    lower.includes('"loggedin": true') ||
    lower.includes('"loggedin":true') ||
    lower.includes("logged in");
  const loggedIn = result.exitCode === 0 && affirmsLogin;
  return { installed: true, loggedIn };
}

/** Plain-language next step for a backend that isn't verified. Never raw text.
 *  Written for a non-technical user: point at the in-app connect step (install
 *  + sign-in happen right inside the app now), never at a Terminal command or
 *  the retired Helper menu. */
export function hintFor(id: BackendId, installed: boolean, loggedIn: boolean): string | null {
  if (loggedIn) return null;
  if (id === "claude") {
    return "Claude isn’t connected yet. Use the connect step right here to install and sign in, then re-check.";
  }
  return "Codex isn’t connected yet. Sign in with the Codex app, then re-check.";
}

/**
 * Resolve the trusted binary path for a backend: the configured path (env >
 * user-config) if it exists on disk, else the bare command name for a PATH
 * lookup. Mirrors the providers' own claudeBin()/codexBin() so detection and
 * execution agree on the same binary. Returns null when even a PATH lookup
 * can't find it (not installed).
 */
function resolveBinary(id: BackendId): string | null {
  if (id === "claude") {
    const envBin = process.env.CLAUDE_BIN;
    if (envBin && existsSync(envBin)) return envBin;
    const known = getUserConfig().claudeBin;
    if (existsSync(known)) return known;
    return onPath("claude");
  }
  const envBin = process.env.CODEX_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  const known = "/opt/homebrew/bin/codex";
  if (existsSync(known)) return known;
  return onPath("codex");
}

/**
 * The trusted claude-binary path (env CLAUDE_BIN > user-config claudeBin > PATH),
 * or null when not installed. Exported so the setup module (lib/claude-setup.ts)
 * resolves the SAME binary detection + turns spawn, instead of duplicating the
 * resolution seam. NEVER derives a path from request input.
 */
export function resolveClaudeBin(): string | null {
  return resolveBinary("claude");
}

/** First PATH dir holding `command`, as an absolute path, else null. */
function onPath(command: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const STATUS_ARGS: Record<BackendId, string[]> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
};

/**
 * Run a backend's status subcommand with a hard timeout, capturing exit +
 * output. NEVER throws — a spawn error / timeout resolves to a not-spawned or
 * killed ProbeResult so the caller can classify it as "not connected". The
 * binary path is the trusted resolveBinary() result; no request input reaches
 * spawn.
 */
function runStatusProbe(id: BackendId, binary: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, STATUS_ARGS[id], {
        stdio: ["ignore", "pipe", "pipe"],
        // Inherit the process env so the CLI reads the same auth config dir the
        // real turns use. No request-derived env is added. NOT scrubbed like the
        // turn-spawning providers (lib/child-env.ts) on purpose (Tier-2 fix-round
        // finding 5, scoped/accepted): this runs a fixed `<cli> status` probe,
        // never model-directed, so there's no Bash-injection path for a leaked
        // env var to exfiltrate through.
        env: { ...process.env },
      });
    } catch {
      finish({ spawned: false, exitCode: null, output: "" });
      return;
    }

    let output = "";
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(0, 4000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ spawned: true, exitCode: null, output });
    }, PROBE_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      // spawn error (ENOENT) — the binary vanished between resolve and spawn.
      finish({ spawned: false, exitCode: null, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ spawned: true, exitCode: code, output });
    });
  });
}

const LABELS: Record<BackendId, string> = {
  claude: "Claude Max",
  codex: "Codex (ChatGPT)",
};

/** Detect one backend end to end: resolve the trusted binary, run the cheap
 *  status probe, classify. Fully fail-safe — any surprise resolves to a
 *  not-installed / not-connected status, never a throw. */
export async function detectBackend(id: BackendId): Promise<BackendStatus> {
  try {
    const binary = resolveBinary(id);
    if (!binary) {
      return { id, label: LABELS[id], installed: false, loggedIn: false, hint: hintFor(id, false, false) };
    }
    const probe = await runStatusProbe(id, binary);
    const { installed, loggedIn } = interpretProbe(id, probe);
    if (!loggedIn && probe.output) {
      // Raw detail to the server log only — never to the user.
      console.error(`[credential-detect] ${id} not verified (exit=${probe.exitCode}): ${probe.output.slice(0, 300)}`);
    }
    return { id, label: LABELS[id], installed, loggedIn, hint: hintFor(id, installed, loggedIn) };
  } catch (err) {
    console.error(`[credential-detect] ${id} detection error:`, err);
    return { id, label: LABELS[id], installed: false, loggedIn: false, hint: hintFor(id, false, false) };
  }
}

/** Detect both backends in parallel (each is independently fail-safe). */
export async function detectBackends(): Promise<BackendStatus[]> {
  return Promise.all([detectBackend("claude"), detectBackend("codex")]);
}
