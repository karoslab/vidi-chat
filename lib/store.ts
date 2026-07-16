import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getUserConfig } from "./user-config.ts";
import { dataDir, secureDataFile } from "./data-dir.ts";
import { type Attachment, removeAttachmentFiles } from "./attachments.ts";

/**
 * Plain-JSON thread storage under data/threads/ (gitignored). One file per
 * thread. No database — this is a personal, single-user app.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** Files the user attached to this message (user messages only). Metadata
   *  only — the bytes live under data/uploads/, referenced by `rel`. */
  attachments?: Attachment[];
  /** Assistant messages only: the stop button cut this turn short — `text`
   *  is whatever had streamed so far, not a complete reply. */
  stopped?: boolean;
}

export interface Thread {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  /** Thread kind. Absent/"chat" = a normal user thread shown in the sidebar.
   *  "intro" = the first-run onboarding chat (T2.2): persisted like any thread
   *  but EXCLUDED from the sidebar thread list / search so it never clutters
   *  the normal history. Opened only by the onboarding intro surface. */
  type?: "chat" | "intro";
  /** "plan" (read-only planning) or "auto" (write tools + trust dial).
   *  "chat"/"act" are legacy aliases (chat→plan, act→auto). */
  mode?: "plan" | "auto" | "chat" | "act";
  /** Reasoning effort dial: low | medium | high | ultra (default medium). */
  effort?: string;
  providerSessionId: string | null;
  /** Claude account id that created providerSessionId. A session belongs to the
   *  config dir that made it; a later turn on a different account must not
   *  --resume it (see lib/accounts.ts). null/absent on legacy threads. */
  sessionAccountId?: string | null;
  /** The settings the stored providerSessionId was CREATED with (FIX 1). A CLI
   *  session is pinned to its model/agent/effort, so when the thread's current
   *  provider/model/effort/mode no longer matches this, the next turn drops the
   *  --resume and starts a fresh session so the switch takes effect. Stamped on
   *  each done event; null/absent on legacy threads (which keep resuming until
   *  the first stamp). See lib/session-fingerprint.ts. */
  sessionFingerprint?: import("./session-fingerprint.ts").SessionFingerprint | null;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

// Resolved at call time via the shared dataDir() (VIDI_DATA_DIR override, else
// <cwd>/data) so a fresh-install rehearsal points at an empty threads dir and
// the tests' per-case chdir still works.
const threadsDir = () => path.join(dataDir(), "threads");

function ensureDir() {
  fs.mkdirSync(threadsDir(), { recursive: true });
}

function fileFor(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("bad thread id");
  return path.join(threadsDir(), `${id}.json`);
}

export function listThreads(): Omit<Thread, "messages">[] {
  ensureDir();
  const out: Omit<Thread, "messages">[] = [];
  for (const f of fs.readdirSync(threadsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const t: Thread = JSON.parse(fs.readFileSync(path.join(threadsDir(), f), "utf8"));
      // The onboarding intro chat (T2.2) is persisted but never shown in the
      // normal thread list — it has its own entry point.
      if (t.type === "intro") continue;
      const { messages, ...meta } = t;
      out.push(meta);
    } catch {
      /* skip corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getThread(id: string): Thread | null {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
  } catch {
    return null;
  }
}

export function saveThread(t: Thread) {
  ensureDir();
  t.updatedAt = Date.now();
  // Write-temp-then-rename so a crash mid-write can't leave a torn file.
  const file = fileFor(t.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
  fs.renameSync(tmp, file);
  secureDataFile(file); // H10: 0600 thread file (transcript PII) + 0700 data/
}

/**
 * Per-thread async mutex. The routes hold a Thread object across the whole
 * provider turn (an await), so two concurrent turns on one thread would
 * last-write-wins clobber each other's messages. Every mutation of an
 * existing thread must go through updateThread()/withThreadLock — never
 * saveThread() a thread object that was read before an await.
 *
 * In-process only (a single launchd/next process owns data/); stashed on
 * globalThis so next-dev HMR doesn't fork the lock table.
 */
const threadLocks: Map<string, Promise<void>> = ((
  globalThis as Record<string, any>
).__vidiThreadLocks ??= new Map());

// Separate map: serializes whole provider turns per thread (see withTurnLock).
const turnLocks: Map<string, Promise<void>> = ((
  globalThis as Record<string, any>
).__vidiTurnLocks ??= new Map());

async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  locks.set(key, gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === gate) locks.delete(key);
  }
}

export async function withThreadLock<T>(
  id: string,
  fn: () => T | Promise<T>
): Promise<T> {
  return withKeyedLock(threadLocks, id, fn);
}

/**
 * Serializes entire provider turns on one thread (a different lock table from
 * withThreadLock, so a turn can call updateThread without deadlocking).
 * Without this, two overlapping turns both --resume the same old provider
 * session and the last done event wins — the other turn's exchange silently
 * vanishes from all future CLI context. Callers must re-read the thread
 * INSIDE this lock to pick up the prior turn's providerSessionId.
 */
export async function withTurnLock<T>(
  id: string,
  fn: () => T | Promise<T>
): Promise<T> {
  return withKeyedLock(turnLocks, id, fn);
}

/**
 * True while a provider turn is running (or queued) on this thread. Lets the
 * client re-attach after navigation/refresh: the SSE reader dies with the
 * page, but the turn doesn't — the UI polls this until the reply lands.
 */
export function isTurnRunning(id: string): boolean {
  return turnLocks.has(id);
}

/**
 * Atomic read-modify-write under the thread lock. Returns the saved thread,
 * or null if the thread no longer exists.
 */
export async function updateThread(
  id: string,
  mutate: (t: Thread) => void | Promise<void>
): Promise<Thread | null> {
  return withThreadLock(id, async () => {
    const t = getThread(id);
    if (!t) return null;
    await mutate(t);
    saveThread(t);
    return t;
  });
}

export function createThread(
  provider: string,
  model: string | null,
  mode: "plan" | "auto" | "chat" | "act" = "plan",
  effort?: string
): Thread {
  const now = Date.now();
  const t: Thread = {
    id: crypto.randomUUID(),
    title: "New chat",
    provider,
    model,
    mode,
    effort,
    providerSessionId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  saveThread(t);
  return t;
}

export function searchThreads(query: string): Omit<Thread, "messages">[] {
  ensureDir();
  const q = query.toLowerCase();
  const out: Omit<Thread, "messages">[] = [];
  for (const f of fs.readdirSync(threadsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const t: Thread = JSON.parse(fs.readFileSync(path.join(threadsDir(), f), "utf8"));
      if (t.type === "intro") continue; // intro chat is out of normal search too
      const matches =
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.text.toLowerCase().includes(q));
      if (matches) {
        const { messages, ...meta } = t;
        out.push(meta);
      }
    } catch {
      /* skip corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteThread(id: string): boolean {
  // Read the thread first so we can drop its uploaded files after the JSON is
  // gone (best-effort; a leftover upload is harmless, a missing thread isn't).
  const t = getThread(id);
  try {
    fs.unlinkSync(fileFor(id));
  } catch {
    return false;
  }
  if (t) {
    try {
      removeAttachmentFiles(t.messages.flatMap((m) => m.attachments ?? []));
    } catch {
      /* best-effort */
    }
  }
  return true;
}

export function excerptTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? oneLine.slice(0, 45) + "…" : oneLine || "New chat";
}

/**
 * Faithful, human-readable Markdown transcript of a thread — for reading/sharing
 * a good session (NOT a memory path; an optional memory-ingest job may already feed gbrain).
 * Nothing is stripped: user/assistant turns become headings + verbatim blocks.
 * Stored messages carry no separate tool events, so any tool activity is already
 * inline in the assistant text and is preserved as-is.
 */
export function threadToMarkdown(t: Thread): string {
  const head = `# ${t.title || "Untitled thread"}\n\n- Thread: \`${t.id}\`\n- Provider: ${t.provider}${t.model ? ` (${t.model})` : ""}\n- Started: ${new Date(t.createdAt).toISOString()}\n`;
  const body = t.messages
    .map((m) => {
      const who = m.role === "user" ? `🧑 ${getUserConfig().displayName}` : "🤖 Vidi";
      return `\n## ${who} · ${new Date(m.ts).toISOString()}\n\n${m.text}\n`;
    })
    .join("");
  return head + body;
}

/** ASCII-safe filename from title (fallback: thread id) for content-disposition. */
export function exportFilename(t: Thread): string {
  const slug = (t.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || t.id}.md`;
}
