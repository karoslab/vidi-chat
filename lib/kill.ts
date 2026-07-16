import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * Emergency stop — the LLM-free safety layer that every autonomous feature
 * (loops, agent fleet) will sit on top of. Two pieces, both deliberately dumb:
 *
 *  - data/KILL: a panic file. While it exists, providers refuse to spawn any
 *    CLI. Survives restarts; cleared explicitly.
 *  - an in-process registry of live provider children, so engaging the switch
 *    SIGKILLs everything immediately instead of just blocking new runs.
 *
 * The voice route matches kill phrases with plain regexes BEFORE any thread or
 * LLM work, and /api/kill is intentionally unauthenticated: the fail-safe must
 * work when quota is exhausted, the store is corrupt, or an agent is
 * misbehaving. It can only ever stop things, never start them.
 *
 * Known gap: SIGKILL reaps the direct CLI child (the token spender), not
 * grandchildren it spawned (a bash tool call in flight). Those exit on their
 * own; we deliberately do NOT use detached process groups because a launchd
 * service restart must still take in-flight children down with it.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/KILL.
const killFile = () => dataPath("KILL");

export interface RunInfo {
  pid: number;
  threadId: string;
  provider: string;
  startedAt: number;
}

interface Killable {
  kill(signal?: NodeJS.Signals | number): boolean;
}

// Stashed on globalThis so next-dev HMR doesn't fork the registry.
const registry: Map<number, { info: RunInfo; child: Killable }> = ((
  globalThis as Record<string, any>
).__vidiRunRegistry ??= new Map());

/** Track a live CLI child; returns the deregister function. */
export function registerRun(info: RunInfo, child: Killable): () => void {
  registry.set(info.pid, { info, child });
  // Identity-safe: after PID reuse, a late unregister from the dead run must
  // not evict the live run that now owns this pid.
  return () => {
    const current = registry.get(info.pid);
    if (current && current.child === child) registry.delete(info.pid);
  };
}

export function listRuns(): RunInfo[] {
  return [...registry.values()].map((r) => r.info);
}

export function isKillEngaged(): boolean {
  return fs.existsSync(killFile());
}

export function killStatus(): { engaged: boolean; since?: number; reason?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(killFile(), "utf8"));
    return { engaged: true, since: raw.ts, reason: raw.reason };
  } catch {
    return { engaged: fs.existsSync(killFile()) };
  }
}

/** SIGKILL every registered child and write the panic file. Never throws. */
export function engageKill(reason: string): { killed: number } {
  let killed = 0;
  for (const [pid, { child }] of [...registry]) {
    try {
      if (child.kill("SIGKILL")) killed++;
    } catch {
      /* already dead */
    }
    registry.delete(pid);
  }
  try {
    fs.mkdirSync(path.dirname(killFile()), { recursive: true });
    fs.writeFileSync(
      killFile(),
      JSON.stringify({ ts: Date.now(), reason, killed }) + "\n"
    );
  } catch {
    /* a failed file write must not stop the kills */
  }
  return { killed };
}

export function clearKill(): boolean {
  try {
    fs.unlinkSync(killFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * Voice grammar for the kill switch. It fires ONLY when the panic command is
 * essentially the whole utterance — after stripping wake word, politeness and
 * urgency filler, the remainder must match a phrase exactly (anchored). This
 * is deliberate: engaging writes a persistent panic file that blocks ALL
 * future runs, so a false positive on a compound sentence ("stop everything
 * and summarize the repo", "kill everything in /tmp", "how does the kill
 * switch work?") is worse than needing a terse second phrase. Bare
 * "kill switch" with no verb is intentionally NOT a match — it's ambiguous.
 * Clear is checked before engage.
 */
export function matchKillCommand(transcript: string): "engage" | "clear" | null {
  const t = transcript
    .toLowerCase()
    .replace(/[.!?,]+/g, " ")
    .replace(/\b(hey |ok )?vidi\b/g, " ")
    .replace(/\b(please|now|right now|immediately)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(clear|release|disengage|reset)( the| my)? kill[\s-]?switch$/.test(t)) {
    return "clear";
  }
  if (
    /^(emergency stop|stop everything|kill everything|abort everything|(stop|kill) all( the)? agents|(engage|hit|trigger|activate|throw|flip|pull)( the| my)? kill[\s-]?switch)$/.test(
      t
    )
  ) {
    return "engage";
  }
  return null;
}
