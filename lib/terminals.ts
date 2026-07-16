import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import crypto from "node:crypto";
import { WORKSPACE_ROOT } from "./workspace.ts";
import { expandTilde } from "./expand-tilde.ts";

/**
 * Managed terminal nodes — CNVS's cnvs_run_shell: agents start long-running
 * processes (dev servers, watchers) here instead of blocking their own turn.
 * Each runs detached with stdout/stderr to a logfile; the registry lets us
 * list, tail, and stop them. Registered in the Phase 0 kill registry too, so
 * the kill switch takes them down.
 *
 * This executes arbitrary shell — reachable only through the token-authed
 * control route, from act-mode agents that already hold Bash, on a loopback
 * single-user box. Same trust boundary as the rest of act mode.
 */

export interface Terminal {
  id: string;
  cmd: string;
  cwd: string;
  pid: number;
  startedAt: number;
  logFile: string;
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/terminals.
const logDir = () => dataPath("terminals");
const DEFAULT_CWD = process.env.WORK_DIR || WORKSPACE_ROOT;

const registry: Map<string, Terminal> = ((globalThis as Record<string, any>)
  .__vidiTerminals ??= new Map());

/**
 * Thrown by {@link startTerminal} when the requested cwd doesn't resolve to a
 * real directory. The shell confirm executor catches it and speaks a friendly
 * refusal — the cwd is carried so the message can name the offending folder.
 */
export class TerminalCwdError extends Error {
  // A plain field (not a constructor parameter property) — Node's strip-only TS
  // loader rejects `constructor(public readonly …)`.
  readonly attemptedCwd: string;
  constructor(attemptedCwd: string) {
    super(`working directory does not exist: ${attemptedCwd}`);
    this.name = "TerminalCwdError";
    this.attemptedCwd = attemptedCwd;
  }
}

export function startTerminal(cmd: string, cwd = DEFAULT_CWD): Terminal {
  // Validate the cwd BEFORE spawn (audit finding 11). A nonexistent cwd — a
  // "~/workspace" the tilde was never expanded on, or a genuinely missing dir —
  // made node's spawn return synchronously with pid `undefined` (a false
  // "success (pid -1)" spoken to the approver) and then emit an async 'error'
  // event that, with no listener anywhere in the repo, became an uncaught
  // exception that CRASHED the whole launchd Next server. We expand the tilde
  // and confirm the directory exists first, so neither the false pid nor the
  // crash is reachable.
  const resolvedCwd = expandTilde(cwd);
  let cwdStat: fs.Stats | null = null;
  try {
    cwdStat = fs.statSync(resolvedCwd);
  } catch {
    cwdStat = null;
  }
  if (!cwdStat || !cwdStat.isDirectory()) {
    throw new TerminalCwdError(cwd);
  }

  fs.mkdirSync(logDir(), { recursive: true });
  const id = crypto.randomBytes(5).toString("hex");
  const logFile = path.join(logDir(), `${id}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(cmd, {
    cwd: resolvedCwd,
    shell: true,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  const term: Terminal = {
    id,
    cmd,
    cwd: resolvedCwd,
    pid: child.pid ?? -1,
    startedAt: Date.now(),
    logFile,
  };
  registry.set(id, term);
  child.unref();
  // Belt-and-suspenders: an 'error' event with no listener is an uncaught
  // exception that would take the whole server down (audit finding 11). Even
  // with the cwd pre-check above, register a handler so ANY async spawn failure
  // (e.g. /bin/sh unavailable) marks the record dead instead of crashing.
  child.on("error", () => {
    const t = registry.get(id);
    if (t) t.pid = -1;
  });
  child.on("exit", () => {
    // Keep the record (logfile stays) but note it's no longer live via pid.
    const t = registry.get(id);
    if (t) t.pid = -1;
  });
  return term;
}

export function listTerminals(): Terminal[] {
  return [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function tailTerminal(id: string, lines = 40): string {
  const t = registry.get(id);
  if (!t) return "";
  try {
    const all = fs.readFileSync(t.logFile, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function stopTerminal(id: string): boolean {
  const t = registry.get(id);
  if (!t) return false;
  try {
    if (t.pid > 0) process.kill(-t.pid, "SIGTERM"); // negative = process group
  } catch {
    try {
      if (t.pid > 0) process.kill(t.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  registry.delete(id);
  return true;
}
