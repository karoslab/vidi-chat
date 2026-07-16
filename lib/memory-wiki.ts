import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { brainRoot, getUserConfig } from "./user-config.ts";
import { dataPath } from "./data-dir.ts";
import { expandTilde } from "./expand-tilde.ts";
import { matchesSecretPath } from "./write-file-jail.ts";
import { workerEffort, workerModelFor } from "./model-policy.ts";

/**
 * Stage 3 of the Vidi Journey — "Your memory".
 *
 * This builds the customer their own plain, human-readable wiki (a real folder
 * of markdown notes, tracked in git so nothing is ever silently lost), seeds it
 * from a short guided interview, and lets them bring in ONE folder they pick.
 *
 * Two hard rules baked in here (decisions locked 2026-07-11):
 *   1. There is NO whole-Mac scanning. "Bring your stuff" only ever reads a
 *      single folder the customer picked by hand, and it mechanically refuses
 *      anything that looks like a secret or lives outside their home folder.
 *   2. The distillation (turning answers and files into notes) runs on the cheap
 *      WORKER model tier (lib/model-policy.ts), never the top model. This is
 *      routine summarizing, not deep planning.
 *
 * The wiki lives at the configured brain root (lib/user-config.ts brainRoot(),
 * which honors the per-install brainDirName override). Everything the customer
 * sees is written in plain words.
 */

/* -------------------------------------------------------------------------- */
/* Where the wiki lives + its shape                                           */
/* -------------------------------------------------------------------------- */

/** The customer's wiki root (the configured brain root). */
export function wikiRoot(): string {
  return brainRoot();
}

/** The three plain-language top-level folders every wiki gets. */
const WIKI_FOLDERS = ["inbox", "journal", "notes"] as const;

/** Absolute path to a file/folder inside the wiki. */
function wikiPath(...segments: string[]): string {
  return path.join(wikiRoot(), ...segments);
}

/** The notes folder — where the interview and "bring your stuff" write. */
export function notesDir(): string {
  return wikiPath("notes");
}

/** The file that records which folders the customer chose to bring in. */
export function sourcesFile(): string {
  return wikiPath("sources.md");
}

/** Small per-install state marker for the journey steps (interview done,
 *  last import). Lives under data/ like the rest of the app's plain-JSON
 *  state, NOT inside the wiki, so it never shows up as one of the customer's
 *  notes. Resolved at call time so tests and a fresh install point at the
 *  right dir. */
function stateFile(): string {
  return dataPath("journey-memory.json");
}

export interface MemoryState {
  /** ISO time the seed interview finished, or null if it never ran. */
  interviewDoneAt: string | null;
  /** How many notes the interview wrote. */
  interviewNotes: number;
  /** Folders the customer brought in, most recent last. */
  imports: { path: string; notes: number; at: string }[];
}

const EMPTY_STATE: MemoryState = {
  interviewDoneAt: null,
  interviewNotes: 0,
  imports: [],
};

export function readMemoryState(): MemoryState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        interviewDoneAt:
          typeof parsed.interviewDoneAt === "string" ? parsed.interviewDoneAt : null,
        interviewNotes:
          typeof parsed.interviewNotes === "number" ? parsed.interviewNotes : 0,
        imports: Array.isArray(parsed.imports) ? parsed.imports : [],
      };
    }
  } catch {
    /* no state yet — a fresh install */
  }
  return { ...EMPTY_STATE };
}

function writeMemoryState(next: MemoryState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2));
}

/* -------------------------------------------------------------------------- */
/* Scaffold — create the wiki (idempotent)                                    */
/* -------------------------------------------------------------------------- */

/** Is `dir` a git repository (has a .git entry)? */
function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Count the markdown notes in notes/. */
export function countNotes(): number {
  try {
    return fs.readdirSync(notesDir()).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** The README, in the customer's own words. */
function readmeBody(): string {
  const name = getUserConfig().displayName;
  return [
    `# ${name}'s memory`,
    "",
    "This folder is your memory. It is a set of plain notes that Vidi can read",
    "and add to, so you do not have to repeat yourself.",
    "",
    "What is in here:",
    "",
    "- inbox: quick things to sort out later.",
    "- journal: day to day notes and what you talked about.",
    "- notes: the things worth keeping, one file each.",
    "- sources.md: a list of folders you chose to bring in.",
    "",
    "Everything is a normal text file. You can open, edit, or delete any of it",
    "yourself at any time. Nothing here leaves your computer on its own.",
    "",
    "It is tracked with git, so a change is never lost by accident.",
    "",
  ].join("\n");
}

/** The first welcome note, so a brand-new wiki already has one real note. */
function welcomeNoteBody(): string {
  const name = getUserConfig().displayName;
  return noteMarkdown(
    "Welcome",
    [
      `This is the start of ${name}'s memory.`,
      "",
      "Vidi will fill it in as you go. You can also add notes yourself.",
      "Try the short questions in setup to get going, or bring in a folder",
      "you already keep notes in.",
    ].join("\n"),
    "Created when your memory was first set up"
  );
}

/**
 * Wrap a note's title + body in the standard markdown shape, with a plain
 * one-line footer saying where it came from. No em or en dashes in the copy.
 */
export function noteMarkdown(title: string, body: string, provenance: string): string {
  return [`# ${title}`, "", body.trim(), "", "---", provenance + ".", ""].join("\n");
}

export interface ScaffoldResult {
  /** True when this call actually created the wiki; false when it already
   *  existed and this call only verified/repaired it. */
  created: boolean;
  root: string;
}

/**
 * Create the customer's wiki, or verify and gently repair an existing one.
 *
 * Idempotent by design: re-running never wipes anything. It makes the folders
 * that are missing, writes the README and the welcome note only if absent,
 * initializes git only if it is not already a repo, and makes a first commit
 * only when there is something to commit.
 */
export function scaffoldWiki(): ScaffoldResult {
  const root = wikiRoot();
  const existedBefore = fs.existsSync(root) && countNotes() > 0 && isGitRepo(root);

  fs.mkdirSync(root, { recursive: true });
  for (const folder of WIKI_FOLDERS) {
    fs.mkdirSync(wikiPath(folder), { recursive: true });
  }
  // A .gitkeep keeps the empty inbox/journal folders in git.
  for (const folder of ["inbox", "journal"] as const) {
    const keep = wikiPath(folder, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  }

  const readme = wikiPath("README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, readmeBody());

  // Seed one real note so the wiki is never empty (verify requires >= 1 note).
  if (countNotes() === 0) {
    fs.writeFileSync(wikiPath("notes", "welcome.md"), welcomeNoteBody());
  }

  ensureGitRepo(root, "Set up your memory");

  return { created: !existedBefore, root };
}

/**
 * Make `dir` a git repo if it is not one, then commit any pending changes with
 * `message`. Sets a local commit identity so it works on a fresh machine that
 * has no global git name/email configured. Best-effort on the commit (a repo
 * with nothing to commit is fine), but the repo itself must exist.
 */
function ensureGitRepo(dir: string, message: string): void {
  if (!isGitRepo(dir)) {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
  }
  // Only commit when the working tree has changes, so a re-run is a no-op.
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (!status.trim()) return;
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=vidi@localhost",
      "-c",
      "user.name=Vidi",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: dir }
  );
}

/** Commit whatever changed in the wiki with a plain message. Safe to call when
 *  nothing changed. Fail-open: a commit hiccup must not lose the written notes,
 *  which are already on disk. */
function commitWiki(message: string): void {
  try {
    ensureGitRepo(wikiRoot(), message);
  } catch {
    /* the notes are written; git bookkeeping is best-effort */
  }
}

export interface WikiVerifyResult {
  ok: boolean;
  reason?: string;
}

/** The wiki is healthy when its folder exists, it is a git repo, and it has at
 *  least one note. */
export function verifyWiki(): WikiVerifyResult {
  const root = wikiRoot();
  if (!fs.existsSync(root)) {
    return { ok: false, reason: "Your memory folder is not set up yet." };
  }
  if (!isGitRepo(root)) {
    return { ok: false, reason: "Your memory folder is not being tracked safely yet." };
  }
  if (countNotes() < 1) {
    return { ok: false, reason: "Your memory has no notes in it yet." };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Writing notes                                                              */
/* -------------------------------------------------------------------------- */

export interface DistilledNote {
  slug: string;
  title: string;
  body: string;
}

/** A function that runs one distillation prompt on the worker tier and returns
 *  the model's raw text. Injected so tests can stand in a fake and the real
 *  provider chain is only pulled in at runtime. */
export type Distiller = (prompt: string) => Promise<string>;

/** Turn an arbitrary label into a safe, single-segment note filename slug. */
export function slugify(raw: string): string {
  const cleaned = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "note";
}

/**
 * Pull the note objects out of the worker's reply. The prompt asks for a JSON
 * array of {slug, title, body}; models sometimes wrap it in prose or a code
 * fence, so we find the first bracketed array and parse that. Anything that is
 * not a well-formed note is dropped rather than trusted. Never throws — a
 * garbled reply yields an empty list, which the caller treats as "nothing to
 * write".
 */
export function parseDistilledNotes(text: string): DistilledNote[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DistilledNote[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const body = typeof rec.body === "string" ? rec.body.trim() : "";
    if (!title || !body) continue;
    let slug = slugify(typeof rec.slug === "string" && rec.slug.trim() ? rec.slug : title);
    // Keep slugs unique so two notes never overwrite one file.
    let unique = slug;
    let n = 2;
    while (seen.has(unique)) unique = `${slug}-${n++}`;
    seen.add(unique);
    out.push({ slug: unique, title, body });
    // Hard cap so a runaway reply can never write hundreds of files.
    if (out.length >= MAX_NOTES_PER_RUN) break;
  }
  return out;
}

/** Never write more than this many notes from a single distillation. */
const MAX_NOTES_PER_RUN = 40;

/**
 * Write a batch of notes into notes/, each as its own markdown file with the
 * given provenance footer. Returns the slugs actually written. The route (not
 * the model) does the writing, so provenance stays clean.
 */
export function writeNotes(notes: DistilledNote[], provenance: string): string[] {
  const dir = notesDir();
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const note of notes) {
    const file = path.join(dir, `${note.slug}.md`);
    fs.writeFileSync(file, noteMarkdown(note.title, note.body, provenance));
    written.push(note.slug);
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* The seed interview                                                         */
/* -------------------------------------------------------------------------- */

export interface InterviewQuestion {
  id: string;
  /** The plain question the customer sees. */
  prompt: string;
}

/**
 * The five short questions. Plain and everyday, no jargon. The whole point is
 * that answering these takes about five minutes and gives Vidi enough to be
 * useful from day one.
 */
export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  { id: "who_you_are", prompt: "Who are you? A few lines about yourself is plenty." },
  { id: "what_you_do", prompt: "What do you do day to day?" },
  { id: "what_building", prompt: "What are you working on or trying to build right now?" },
  { id: "who_matters", prompt: "Who are the people that matter most in your life and work?" },
  { id: "how_you_work", prompt: "How do you like to work? What helps you, and what gets in the way?" },
] as const;

/** Keep each answer to a sane length before it goes to the model. */
const MAX_ANSWER_CHARS = 4000;

/**
 * Build the worker-tier prompt that turns the five answers into 15 to 20 short,
 * linked notes. We ask for a strict JSON array so the server can parse it and
 * do the writing itself.
 */
export function buildInterviewPrompt(answers: Record<string, string>): string {
  const lines: string[] = [];
  for (const q of INTERVIEW_QUESTIONS) {
    const a = (answers[q.id] || "").trim().slice(0, MAX_ANSWER_CHARS);
    if (a) lines.push(`Question: ${q.prompt}\nAnswer: ${a}\n`);
  }
  return [
    "You are helping set up a personal memory for someone. Below are their",
    "answers to a few questions about themselves.",
    "",
    "Turn this into 15 to 20 short notes. Each note is one clear idea: a person,",
    "a project, a preference, a fact, a goal. Keep every note to a few sentences.",
    "",
    "Link the notes to each other. When a note mentions something that has its",
    "own note, write it as a wiki link like [[slug-of-that-note]] using that",
    "note's slug. Aim for a few links in each note so the memory is connected.",
    "",
    "Write in plain, everyday language. Do not invent facts that are not in the",
    "answers. Do not use em dashes or en dashes.",
    "",
    "Reply with ONLY a JSON array, nothing else. Each item must be an object",
    'with exactly these keys: "slug" (short, lowercase, words joined by hyphens),',
    '"title" (a few words), and "body" (the note text, may contain [[links]]).',
    "",
    "Here are the answers:",
    "",
    lines.join("\n"),
  ].join("\n");
}

export interface InterviewResult {
  written: number;
  slugs: string[];
}

/**
 * Run the seed interview: distill the answers on the worker tier, write the
 * notes, commit, and record that the interview is done. `distill` is injected
 * (defaults to the real worker call) so this is unit-testable with a fake.
 */
export async function runInterview(
  answers: Record<string, string>,
  distill: Distiller = workerDistill
): Promise<InterviewResult> {
  const prompt = buildInterviewPrompt(answers);
  const raw = await distill(prompt);
  const notes = parseDistilledNotes(raw);
  const slugs = writeNotes(notes, "Saved from your setup questions");
  commitWiki("Add notes from your setup questions");

  const state = readMemoryState();
  writeMemoryState({
    ...state,
    interviewDoneAt: new Date().toISOString(),
    interviewNotes: slugs.length,
  });
  return { written: slugs.length, slugs };
}

/* -------------------------------------------------------------------------- */
/* Bring your stuff — one folder the customer picked                          */
/* -------------------------------------------------------------------------- */

/** Text-like file extensions we will read. Anything else is treated as binary
 *  and skipped. Deliberately small and boring. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".rtf",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".org",
  ".log",
]);

/** Bounds on one "bring your stuff" run so it can never read a whole disk. */
export const INGEST_LIMITS = {
  maxFiles: 40,
  maxTotalBytes: 512 * 1024,
  maxFileBytes: 64 * 1024,
} as const;

/** The current process user's home, resolved from the process (never a
 *  hardcoded path), matching lib/write-file-jail.ts. */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

function isInsideHome(resolved: string): boolean {
  const home = path.resolve(homeDir());
  return resolved === home || resolved.startsWith(home + path.sep);
}

export interface FolderValidation {
  ok: boolean;
  /** Plain-language reason when refused (safe to show verbatim). */
  reason?: string;
  /** The resolved absolute path when ok. */
  resolved?: string;
}

/**
 * Decide whether a folder the customer explicitly picked may be read. Refused
 * unless ALL hold: it is a real directory, it sits inside the customer's home
 * folder, and it does not match any secret path glob. There is NO discovery
 * here: the caller must have handed us an exact path the customer chose.
 */
export function validateSourceFolder(inputPath: string): FolderValidation {
  const trimmed = (inputPath ?? "").trim();
  if (!trimmed) return { ok: false, reason: "Pick a folder to bring in first." };
  const raw = expandTilde(trimmed);
  if (!path.isAbsolute(raw)) {
    return { ok: false, reason: "Give the full path to the folder, not a partial one." };
  }
  const resolved = path.resolve(raw);
  if (!isInsideHome(resolved)) {
    return {
      ok: false,
      reason: "I can only bring in a folder from inside your home folder.",
    };
  }
  // Most SECRET_PATHS directory globs are authored as "<dir>/**" (matches
  // anything INSIDE the dir, e.g. ~/.ssh/**), which does not match the directory
  // path itself (no trailing separator). So also probe a synthetic file inside
  // `resolved` — this catches "the customer pointed straight at ~/.ssh" the same
  // way collectTextFiles already catches every file inside it, but refuses up
  // front with a clear reason instead of silently reading zero files.
  if (matchesSecretPath(resolved) || matchesSecretPath(path.join(resolved, "probe"))) {
    return {
      ok: false,
      reason: "That looks like a private or system folder, so I will not read it.",
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, reason: "I could not find that folder." };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "That is not a folder." };
  }
  return { ok: true, resolved };
}

/** A file is text-like if its extension is on the allowlist AND its first bytes
 *  carry no null byte (a quick binary sniff). */
function looksTextLike(file: string): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(512);
      const read = fs.readSync(fd, buf, 0, 512, 0);
      return !buf.subarray(0, read).includes(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

interface CollectedFile {
  relPath: string;
  text: string;
}

/**
 * Walk `root` one directory deep-first, collecting text-like files up to the
 * limits. Skips hidden files/folders, secret paths, and binaries. Stops as soon
 * as a limit is hit. Pure read, no writes.
 */
export function collectTextFiles(root: string): {
  files: CollectedFile[];
  skipped: number;
} {
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const stack: string[] = [root];

  while (stack.length && files.length < INGEST_LIMITS.maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden files/folders
      const full = path.join(dir, entry.name);
      if (matchesSecretPath(full)) {
        skipped++;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= INGEST_LIMITS.maxFiles) break;
      if (!looksTextLike(full)) {
        skipped++;
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > INGEST_LIMITS.maxFileBytes) {
        skipped++;
        continue;
      }
      if (totalBytes + stat.size > INGEST_LIMITS.maxTotalBytes) {
        skipped++;
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        skipped++;
        continue;
      }
      totalBytes += stat.size;
      files.push({ relPath: path.relative(root, full), text });
    }
  }
  return { files, skipped };
}

/** Build the worker-tier prompt that distills the picked files into linked
 *  notes. Same JSON-array shape as the interview. */
export function buildImportPrompt(folderPath: string, files: CollectedFile[]): string {
  const blocks = files
    .map((f) => `FILE: ${f.relPath}\n${f.text.slice(0, INGEST_LIMITS.maxFileBytes)}`)
    .join("\n\n----\n\n");
  return [
    "You are helping someone bring their existing notes into a personal memory.",
    `They picked the folder ${folderPath}. Below are the text files from it.`,
    "",
    "Turn the important, lasting content into short notes. Each note is one clear",
    "idea. Skip throwaway or duplicate content. Keep every note to a few",
    "sentences.",
    "",
    "Link the notes to each other with wiki links like [[slug-of-that-note]]",
    "when one note mentions something that has its own note.",
    "",
    "Write in plain, everyday language. Do not invent facts. Do not use em dashes",
    "or en dashes.",
    "",
    "Reply with ONLY a JSON array, nothing else. Each item must be an object with",
    'exactly these keys: "slug" (short, lowercase, hyphenated), "title" (a few',
    'words), and "body" (the note text, may contain [[links]]).',
    "",
    "Here are the files:",
    "",
    blocks,
  ].join("\n");
}

/** Append a plain line to sources.md recording a folder the customer brought
 *  in. Creates the file with a header the first time. */
export function recordSource(folderPath: string, noteCount: number): void {
  const file = sourcesFile();
  const when = new Date().toISOString().slice(0, 10);
  const line = `- ${folderPath} brought in on ${when}, ${noteCount} notes\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      ["# Folders you brought in", "", "These are folders you chose to add to your memory.", "", line].join("\n")
    );
  } else {
    fs.appendFileSync(file, line);
  }
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  written: number;
  filesRead: number;
  filesSkipped: number;
  source?: string;
}

/**
 * The one-shot "bring your stuff" ingestion. Validates the picked folder, reads
 * its text-like files within the limits, distills them on the worker tier,
 * writes the notes, records the source, and commits. `distill` is injected so
 * this is unit-testable without the provider chain.
 *
 * This is intentionally one-shot. The ongoing background "memory sources" engine
 * (watching a folder over time) is a later phase and is deliberately NOT here.
 */
export async function ingestFolder(
  inputPath: string,
  distill: Distiller = workerDistill
): Promise<ImportResult> {
  const check = validateSourceFolder(inputPath);
  if (!check.ok || !check.resolved) {
    return { ok: false, reason: check.reason, written: 0, filesRead: 0, filesSkipped: 0 };
  }
  const resolved = check.resolved;
  const { files, skipped } = collectTextFiles(resolved);
  if (files.length === 0) {
    return {
      ok: false,
      reason: "I did not find any readable text files in that folder.",
      written: 0,
      filesRead: 0,
      filesSkipped: skipped,
      source: resolved,
    };
  }
  const raw = await distill(buildImportPrompt(resolved, files));
  const notes = parseDistilledNotes(raw);
  const slugs = writeNotes(notes, `Saved from the folder ${resolved}`);
  recordSource(resolved, slugs.length);
  commitWiki("Bring in notes from a folder you picked");

  const state = readMemoryState();
  writeMemoryState({
    ...state,
    imports: [...state.imports, { path: resolved, notes: slugs.length, at: new Date().toISOString() }],
  });

  return {
    ok: true,
    written: slugs.length,
    filesRead: files.length,
    filesSkipped: skipped,
    source: resolved,
  };
}

/* -------------------------------------------------------------------------- */
/* The real worker-tier distiller                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run one distillation prompt on the WORKER tier (lib/model-policy.ts): Claude
 * sonnet at medium effort, in plan mode (read-only). The route does the file
 * writing, so the model only ever produces text here. Dynamically imports the
 * provider chain so this module stays loadable under `node --test`.
 */
export async function workerDistill(prompt: string): Promise<string> {
  const { getProvider } = await import("./providers/index.ts");
  const provider = getProvider("claude");
  if (!provider) throw new Error("Claude is not available to build your notes right now.");
  let out = "";
  const gen = provider.sendMessage({
    threadId: `memory-distill-${Date.now()}`,
    userMessage: prompt,
    model: workerModelFor("claude"),
    mode: "plan",
    effort: workerEffort(),
  });
  for await (const ev of gen) {
    if (ev.type === "delta") out += ev.text;
    else if (ev.type === "done") out = ev.fullText || out;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out;
}
