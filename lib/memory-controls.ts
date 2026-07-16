import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { brainPath, getUserConfig } from "./user-config.ts";
import { dataPath } from "./data-dir.ts";
import { redactSecrets } from "./redact.ts";

/**
 * User-facing memory OWNERSHIP controls (view / correct / forget / export /
 * reset). This is a CAPABILITY FREEZE: it exposes controls over the memory Vidi
 * already keeps, and adds NO new memory source or recall behavior.
 *
 * Two stores exist today and this module reads/edits exactly those two:
 *   1. "remember this" notes — one Markdown file per note under
 *      <brainRoot>/vidi/notes/<stamp>.md, written by lib/brain.ts rememberNote.
 *      These are the PRIMARY data; the gbrain search index is rebuilt from them.
 *   2. Shared fleet memory — data/memory.jsonl (lib/memory.ts).
 *
 * It NEVER touches thread history or the wider brain dir (wiki/ etc.); reset
 * only moves vidi/notes and memory.jsonl, and it MOVES (never rm's) them into a
 * recoverable on-disk trash folder.
 */

/** The attribution line every remembered note carries (matches rememberNote). */
export const NOTE_SOURCE = "you asked Vidi to remember this";

/** The exact phrase resetMemory() requires — plain language, spoken verbatim. */
export const RESET_CONFIRM_PHRASE = "delete my memory";

export interface RememberedNote {
  /** The note's filename, e.g. "2026-07-10-03-20-15.md" — its stable id. */
  id: string;
  /** ISO timestamp, parsed from the filename stamp, else the file mtime. */
  createdAt: string;
  /** First line of the note (leading "# " stripped) — a human title. */
  title: string;
  /** The full raw Markdown of the note file. */
  body: string;
  /** Where this memory came from, in plain language. */
  source: string;
}

export interface FleetMemoryItem {
  ts: number;
  agent: string;
  text: string;
  tags?: string[];
}

export interface MemoryListing {
  notes: RememberedNote[];
  fleetMemory: FleetMemoryItem[];
}

/** A refused control action carries a plain-language message safe to surface. */
export class MemoryControlError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MemoryControlError";
    this.status = status;
  }
}

/** <brainRoot>/vidi/notes — resolved at call time (brainRoot re-validates the
 *  configured brain dir stays inside the workspace, see user-config.brainRoot). */
function notesDir(): string {
  return brainPath("vidi", "notes");
}

const fleetMemoryFile = () => dataPath("memory.jsonl");

/**
 * Fire-and-forget `gbrain sync` so the search index soft-deletes/reindexes after
 * a file change. Mirrors lib/brain.ts's spawn (PATH-prepend the bin dir so a
 * launchd service without bun on PATH still finds the bun-shebang script).
 * Fail-open by design — a broken or missing brain must never break a control
 * action on the primary files. Skipped under the test sentinel so `npm test`
 * never shells out to the real brain.
 */
function triggerGbrainSync(): void {
  if (process.env.VIDI_TEST === "1") return;
  try {
    const bin = getUserConfig().gbrainBin;
    const binDir = path.dirname(bin);
    const child = spawn(bin, ["sync"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best-effort: sync must never break a control action */
  }
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/;

/** Parse the filename stamp (rememberNote writes an ISO-UTC stamp) into an ISO
 *  string; fall back to the file mtime when the name isn't a stamp. */
function createdAtFor(fileName: string, absPath: string): string {
  const m = STAMP_RE.exec(fileName);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  try {
    return new Date(fs.statSync(absPath).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** First non-empty line of the note, with a leading Markdown "# " stripped. */
function titleFor(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, "").slice(0, 120);
  }
  return "(empty note)";
}

/** Read one note file into a RememberedNote (raw markdown preserved as body). */
function readNote(fileName: string): RememberedNote {
  const abs = path.join(notesDir(), fileName);
  const body = fs.readFileSync(abs, "utf8");
  return {
    id: fileName,
    createdAt: createdAtFor(fileName, abs),
    title: titleFor(body),
    body,
    source: NOTE_SOURCE,
  };
}

/**
 * Enumerate the remembered notes (newest first) and the fleet memory entries.
 * Fail-soft: a missing store yields an empty list, never a throw.
 */
export function listNotes(): MemoryListing {
  let notes: RememberedNote[] = [];
  try {
    const dir = notesDir();
    notes = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      // Skip any entry that is not a regular file (a symlink note would leak the
      // file it points at into the listing/export — same jail as resolveNoteFile).
      .filter((name) => {
        try {
          return fs.lstatSync(path.join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .map(readNote)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    notes = []; // no notes dir yet
  }
  return { notes, fleetMemory: listFleetMemory() };
}

/** Fleet memory entries from data/memory.jsonl (skips corrupt lines). */
export function listFleetMemory(): FleetMemoryItem[] {
  const out: FleetMemoryItem[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(fleetMemoryFile(), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.ts === "number" && typeof e.text === "string") {
        out.push({ ts: e.ts, agent: e.agent ?? "vidi", text: e.text, tags: e.tags });
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/**
 * Resolve a note id to its absolute path INSIDE the notes dir, or throw. The
 * jail mirrors validateBrainDirName / checkWriteFileTarget: a note id must be a
 * single plain path segment — no separators, no "."/"..", no traversal — so
 * "../../etc/passwd" or "a/b" can never escape the notes dir.
 */
function resolveNoteFile(id: string): string {
  const raw = (id ?? "").trim();
  if (!raw) throw new MemoryControlError("I need a note to work with.");
  if (
    raw === "." ||
    raw === ".." ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes(path.sep) ||
    path.basename(raw) !== raw
  ) {
    throw new MemoryControlError("That memory reference isn't allowed.");
  }
  const dir = notesDir();
  const resolved = path.resolve(dir, raw);
  // Belt-and-suspenders: after the single-segment check, the resolved path must
  // still be strictly inside the notes dir.
  if (resolved !== path.join(dir, raw) || !resolved.startsWith(dir + path.sep)) {
    throw new MemoryControlError("That memory reference isn't allowed.");
  }
  // The single-segment string jail stops "a/b" and "../x", but a note that is a
  // SYMLINK still resolves inside the notes dir while pointing anywhere. Reading
  // through it would leak an arbitrary file into an export; writing through it
  // (correctNote) would overwrite a file outside the write jail. Refuse any note
  // whose own entry is a symlink — mirrors write-file-jail's SECRET_PATHS intent.
  let linkStat: fs.Stats | undefined;
  try {
    linkStat = fs.lstatSync(resolved);
  } catch {
    linkStat = undefined; // does not exist yet — callers handle the 404
  }
  if (linkStat && !linkStat.isFile()) {
    throw new MemoryControlError("That memory reference isn't allowed.");
  }
  return resolved;
}

/** Delete one remembered note, then fire-and-forget a gbrain sync (fail-open). */
export function forgetNote(id: string): void {
  const abs = resolveNoteFile(id);
  if (!fs.existsSync(abs)) {
    throw new MemoryControlError("I couldn't find that memory to forget.", 404);
  }
  fs.rmSync(abs);
  triggerGbrainSync();
}

/**
 * Rewrite a note's body, preserving its attribution footer and appending a
 * "corrected on <date>" line. Same jail + fail-open sync as forgetNote. The new
 * body is secret-redacted (the note is gbrain-synced, same as rememberNote).
 */
export function correctNote(id: string, newBody: string): void {
  const abs = resolveNoteFile(id);
  if (!fs.existsSync(abs)) {
    throw new MemoryControlError("I couldn't find that memory to correct.", 404);
  }
  const trimmed = redactSecrets((newBody ?? "").trim());
  if (!trimmed) {
    throw new MemoryControlError("A corrected memory can't be empty.");
  }
  // Preserve the original attribution footer (the italic "*<name> told Vidi to
  // remember this on <date>.*" line) so provenance survives the correction.
  const existing = fs.readFileSync(abs, "utf8");
  const footer = existing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\*.*told Vidi to remember this.*\*$/.test(l))
    .pop();
  const today = new Date().toISOString().slice(0, 10);
  const attribution =
    footer ||
    `*${getUserConfig().displayName} told Vidi to remember this.*`;
  // Content FIRST (search excerpts truncate hard — the header must not hide the
  // note text; same rationale as rememberNote).
  fs.writeFileSync(
    abs,
    `# ${trimmed.slice(0, 80)}\n\n${trimmed}\n\n${attribution}\n*Corrected on ${today}.*\n`
  );
  triggerGbrainSync();
}

export interface MemoryExport {
  schemaVersion: 1;
  exportedAt: string;
  displayName: string;
  notes: (RememberedNote & { markdown: string })[];
  fleetMemory: FleetMemoryItem[];
  explanation: { primary: string; rebuildable: string };
}

/**
 * Assemble a portable JSON manifest of everything Vidi remembers. The notes ARE
 * the primary data (markdown = the raw file); the search index is derived and
 * can be rebuilt from them, which the explanation block states plainly.
 */
export function exportMemory(): MemoryExport {
  const { notes, fleetMemory } = listNotes();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    displayName: getUserConfig().displayName,
    notes: notes.map((n) => ({ ...n, markdown: n.body })),
    fleetMemory,
    explanation: {
      primary: "notes are the primary data",
      rebuildable: "the search index is rebuilt from these files",
    },
  };
}

export interface ResetResult {
  trashDir: string;
  movedNotes: boolean;
  movedFleetMemory: boolean;
}

/**
 * Fully reset Vidi's memory — but recoverably. Requires the exact confirm
 * phrase, then MOVES (never deletes) vidi/notes and data/memory.jsonl into
 * <dataDir>/trash/memory-reset-<timestamp>/ so the reset can be undone from
 * disk. NEVER touches thread history or the wider brain dir. Fires a gbrain
 * sync afterwards (fail-open).
 */
export function resetMemory({ confirmPhrase }: { confirmPhrase: string }): ResetResult {
  // Strict equality (no trim): the phrase must be typed EXACTLY, so a stray
  // space can't sail a destructive reset through.
  if (confirmPhrase !== RESET_CONFIRM_PHRASE) {
    throw new MemoryControlError(
      `To reset, the confirm phrase must be exactly "${RESET_CONFIRM_PHRASE}".`
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashDir = dataPath("trash", `memory-reset-${stamp}`);
  fs.mkdirSync(trashDir, { recursive: true });

  let movedNotes = false;
  const dir = notesDir();
  if (fs.existsSync(dir)) {
    fs.renameSync(dir, path.join(trashDir, "notes"));
    movedNotes = true;
  }

  let movedFleetMemory = false;
  const fleet = fleetMemoryFile();
  if (fs.existsSync(fleet)) {
    fs.renameSync(fleet, path.join(trashDir, "memory.jsonl"));
    movedFleetMemory = true;
  }

  triggerGbrainSync();
  return { trashDir, movedNotes, movedFleetMemory };
}
