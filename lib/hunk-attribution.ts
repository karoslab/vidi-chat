import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";
import { appendJournal, type HunkActorTally } from "./journal.ts";

/**
 * Agent-vs-external hunk attribution for the journal / trust surface.
 *
 * The question this answers: for a given file change, which contiguous line
 * regions (hunks) were made by one of Vidi's own agent sessions, and which
 * appeared from OUTSIDE any session (a human edit, another tool, a git
 * operation)? That agent-vs-external split is the trust signal — an external
 * hunk is one nobody in-session is accountable for.
 *
 * Approach (the "diff at session boundaries" half, not fs-watch — the simplest
 * reliable option, and consistent with journal.ts's file-of-record model):
 *   - Sessions are recorded as time WINDOWS via openSession/closeSession, kept
 *     in a small data/-local store (mirrors journal.ts: dataPath + 0600).
 *   - A change carries the wall-clock ts at which it was observed. actorAt()
 *     resolves that ts to the session active then, or 'external'.
 *   - computeHunks() is a pure LCS line diff, so attribution is unit-testable
 *     without any spawn or filesystem.
 *
 * A single before/after snapshot has one timestamp, so every hunk in one change
 * shares an actor. The per-hunk shape is deliberate: an incremental tracker that
 * diffs more often can attribute adjacent hunks to different sessions without an
 * API change.
 */

/** The sentinel actor for a hunk made outside any known agent session. */
export const EXTERNAL_ACTOR = "external";

/** A recorded agent-session time window. end === null means still open. */
export interface SessionWindow {
  sessionId: string;
  start: number;
  end: number | null;
  /** Git repo the session's edits are diffed against (the boundary-diff capture
   *  root). Present only for windows opened with a cwd. */
  cwd?: string;
  /** Git tree-ish snapshotted at open, the baseline for the close-time diff.
   *  null when cwd was given but is not a git repo (capture then no-ops). */
  baseline?: string | null;
}

/** A contiguous changed region between two versions of a file. Line numbers are
 *  1-based; for a pure insertion beforeStart is the line it follows in the
 *  before-file, for a pure deletion afterStart is the line it follows after. */
export interface Hunk {
  beforeStart: number;
  afterStart: number;
  removed: string[];
  added: string[];
}

export interface AttributedHunk extends Hunk {
  /** A session id, or EXTERNAL_ACTOR. */
  actor: string;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
  /** Wall-clock time the change was observed (ms since epoch). */
  ts: number;
}

export interface ChangeAttribution {
  path: string;
  ts: number;
  hunks: AttributedHunk[];
}

// ---- line diff ------------------------------------------------------------

/** Split file content into lines. Empty content is zero lines (not one blank
 *  line), so an empty→populated change reads as a pure insertion. */
function toLines(s: string): string[] {
  return s.length === 0 ? [] : s.split("\n");
}

type Op = { kind: "eq" | "del" | "add"; line: string };

/** Classic LCS line diff. O(n*m) time/space — fine for the source-file-sized
 *  inputs this sees; it is never fed a multi-megabyte blob. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++] });
  while (j < m) ops.push({ kind: "add", line: b[j++] });
  return ops;
}

/** Diff two versions of a file into contiguous changed hunks. A hunk is a
 *  maximal run of del/add ops bounded by unchanged (eq) lines. */
export function computeHunks(before: string, after: string): Hunk[] {
  const ops = diffLines(toLines(before), toLines(after));
  const hunks: Hunk[] = [];
  let bi = 0; // 0-based index into before
  let ai = 0; // 0-based index into after
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === "eq") {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      bi++;
      ai++;
      continue;
    }
    if (!cur) cur = { beforeStart: bi + 1, afterStart: ai + 1, removed: [], added: [] };
    if (op.kind === "del") {
      cur.removed.push(op.line);
      bi++;
    } else {
      cur.added.push(op.line);
      ai++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// ---- actor resolution -----------------------------------------------------

/** The actor active at ts: the session whose window contains ts, or
 *  EXTERNAL_ACTOR. On overlap, the innermost (latest-started) window wins, so a
 *  nested delegate session out-attributes its parent. */
export function actorAt(ts: number, windows: SessionWindow[]): string {
  let best: SessionWindow | null = null;
  for (const w of windows) {
    if (ts < w.start) continue;
    if (w.end !== null && ts > w.end) continue;
    if (!best || w.start > best.start) best = w;
  }
  return best ? best.sessionId : EXTERNAL_ACTOR;
}

/** Decompose a change into hunks and tag each with the actor at change time. */
export function attributeChange(change: FileChange, windows: SessionWindow[]): ChangeAttribution {
  const actor = actorAt(change.ts, windows);
  const hunks = computeHunks(change.before, change.after).map((h) => ({ ...h, actor }));
  return { path: change.path, ts: change.ts, hunks };
}

/** Collapse attributed hunks into a per-actor count, in first-seen order. */
export function summarizeActors(attr: ChangeAttribution): HunkActorTally[] {
  const counts = new Map<string, number>();
  for (const h of attr.hunks) counts.set(h.actor, (counts.get(h.actor) ?? 0) + 1);
  return [...counts.entries()].map(([actor, hunks]) => ({ actor, hunks }));
}

// ---- session window store (boundary tracking) -----------------------------

// A bounded JSON array in data/ — like journal.jsonl it is a recent-history
// drawer, not an archive. Windows are few and small, so a whole-file
// read-modify-write (atomic tmp+rename) is simpler and reliable vs JSONL.
const windowsFile = () => dataPath("hunk-sessions.json");
const MAX_WINDOWS = 500;

export function readWindows(): SessionWindow[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowsFile(), "utf8"));
    return Array.isArray(parsed) ? (parsed as SessionWindow[]) : [];
  } catch {
    return [];
  }
}

function writeWindows(windows: SessionWindow[]): void {
  fs.mkdirSync(path.dirname(windowsFile()), { recursive: true });
  const tmp = windowsFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(windows));
  fs.renameSync(tmp, windowsFile());
  secureDataFile(windowsFile()); // 0600 (session ids) + 0700 data/
}

/**
 * Record the start of an agent session window. Idempotent: a second open for a
 * session that is already open is ignored, so a resume doesn't double-record.
 *
 * Pass `cwd` (a git repo) to enable close-time boundary capture: the current
 * working tree is snapshotted now as the diff baseline, so every file that
 * changes before closeSession() is attributed to this session. Omit it (tests,
 * chat agents that never edit) to only record the window.
 */
export function openSession(sessionId: string, ts: number, cwd?: string): void {
  try {
    const windows = readWindows();
    if (windows.some((w) => w.sessionId === sessionId && w.end === null)) return;
    const w: SessionWindow = { sessionId, start: ts, end: null };
    if (cwd) {
      w.cwd = cwd;
      w.baseline = snapshotWorkspace(cwd);
    }
    windows.push(w);
    writeWindows(windows.slice(-MAX_WINDOWS));
  } catch {
    /* window bookkeeping must never break a turn */
  }
}

/**
 * Close the open window(s) for a session, stamping the end time. For a window
 * opened with a git cwd + baseline, this is also the capture boundary: every
 * file changed since the baseline is diffed and journaled as an attributed
 * FileChange for this session (the "diff at session boundaries" mechanism).
 */
export function closeSession(sessionId: string, ts: number): void {
  try {
    const windows = readWindows();
    const captured: SessionWindow[] = [];
    let changed = false;
    for (const w of windows) {
      if (w.sessionId === sessionId && w.end === null) {
        w.end = ts;
        changed = true;
        if (w.cwd && w.baseline) captured.push(w);
      }
    }
    if (changed) writeWindows(windows);
    // Capture AFTER the end time is persisted, so journalFileChange's actorAt(ts)
    // resolves this now-closed window (end is inclusive) to sessionId.
    for (const w of captured) {
      // Concurrent act agents editing the SAME repo can't be separated by a
      // boundary diff of one shared working tree: the first to close would
      // capture the other's in-flight edits (mis-attributing them to whichever
      // window is still open), and the second's older baseline would re-journal
      // the identical hunks. When another act window overlaps this one in the
      // same cwd, skip capture entirely — the agent-vs-external signal is worth
      // less than the wrong per-agent signal it would otherwise emit.
      if (overlappingActWindowExists(w, windows)) continue;
      captureChangesSince(sessionId, w.baseline!, w.cwd!, ts);
    }
  } catch {
    /* best-effort */
  }
}

/** True if any OTHER window sharing target's cwd overlaps target's time span (a
 *  still-open window counts as overlapping through target's close). */
function overlappingActWindowExists(target: SessionWindow, windows: SessionWindow[]): boolean {
  const targetEnd = target.end ?? Infinity;
  for (const w of windows) {
    if (w === target || w.cwd !== target.cwd) continue;
    const wEnd = w.end ?? Infinity;
    if (w.start <= targetEnd && wEnd >= target.start) return true;
  }
  return false;
}

// ---- git boundary capture -------------------------------------------------

function git(cwd: string, args: string[], trim = true): string {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  // trim is right for refs / porcelain lines, but NOT for file content: trimming
  // a blob's trailing newline would misalign it against the un-trimmed
  // working-tree read and fabricate a spurious trailing-line hunk.
  return trim ? out.trim() : out;
}

/**
 * Snapshot the current working tree as a git tree-ish WITHOUT disturbing it, to
 * serve as a diff baseline. `git stash create` captures tracked modifications on
 * top of HEAD; empty output means a clean tree, so HEAD is the baseline. Returns
 * null if cwd is not a git repo (or has no commit yet) — capture then no-ops.
 */
export function snapshotWorkspace(cwd: string): string | null {
  try {
    const stash = git(cwd, ["stash", "create"]);
    return stash || git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Diff every tracked file changed between `baseline` and the current working
 * tree, journaling each as an attributed FileChange for `sessionId`. Untracked
 * new files are not captured (they are absent from the git diff) — a documented
 * limitation of the boundary-diff approach. Fully best-effort.
 */
export function captureChangesSince(
  sessionId: string,
  baseline: string,
  cwd: string,
  ts: number
): void {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const names = git(cwd, ["diff", "--name-only", baseline, "--"]).split("\n").filter(Boolean);
    for (const rel of names) {
      let before = "";
      try {
        before = git(cwd, ["show", `${baseline}:${rel}`], false); // raw blob, no trim
      } catch {
        before = ""; // new file: absent from the baseline tree
      }
      let after = "";
      try {
        after = fs.readFileSync(path.join(root, rel), "utf8");
      } catch {
        after = ""; // deleted in the working tree
      }
      if (before === after) continue;
      journalFileChange({ threadId: sessionId, path: rel, before, after, ts });
    }
  } catch {
    /* best-effort: capture must never break a turn's teardown */
  }
}

// ---- journal surfacing ----------------------------------------------------

/**
 * Attribute a file change against the current session windows and record it on
 * the journal as a "FileChange" entry carrying the agent-vs-external hunk split.
 * Returns the attribution, or null when nothing changed (no journal entry).
 */
export function journalFileChange(input: {
  threadId: string;
  path: string;
  before: string;
  after: string;
  ts: number;
}): ChangeAttribution | null {
  const attr = attributeChange(
    { path: input.path, before: input.before, after: input.after, ts: input.ts },
    readWindows()
  );
  if (attr.hunks.length === 0) return null;
  const tally = summarizeActors(attr);
  const desc = tally.map((t) => `${t.actor}:${t.hunks}`).join(" ");
  appendJournal({
    ts: input.ts,
    threadId: input.threadId,
    tool: "FileChange",
    summary: `${input.path} [${desc}]`,
    attribution: tally,
  });
  return attr;
}
