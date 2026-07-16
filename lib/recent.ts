import fs from "node:fs";
import path from "node:path";
import { getThread, listThreads } from "./store.ts";
import { workspacePath } from "./workspace.ts";
import { getUserConfig } from "./user-config.ts";
import { stripLeadingControlTokens } from "./untrusted.ts";

/**
 * 48-hour recent buffer — the free bridge over the 6h brain-ingest gap.
 *
 * gbrain only knows what brain-ingest has committed and synced (every 6h), so
 * "vidi, remember X" followed minutes later by "what did I say about X?" found
 * nothing. This module answers from what hasn't reached the brain yet: fresh
 * MyWiki note files and the last two days of voice/vision conversation.
 * No LLM, no gbrain, no network — a few file reads and word overlap, <10ms.
 *
 * Fail-open like autoRecall: any error means "no recent context", never a
 * broken voice turn.
 */

const KARWIKI_NOTES_DIR = workspacePath(getUserConfig().brainDirName, "vidi", "notes");
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Conversation threads worth recalling from: the persistent voice thread and
 *  the vision archive thread (screenshot Q&A history posted by the Mac app). */
const RECENT_THREAD_TITLES = ["voice", "vision"];
const MAX_MESSAGES_PER_THREAD = 30;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 300;

export interface RecentSource {
  /** Where this came from, spoken-friendly: "note", "voice", "vision". */
  label: string;
  ts: number;
  text: string;
}

export interface RecentBufferOptions {
  notesDir?: string;
  threadTitles?: string[];
  nowMs?: number;
}

/** Everything from the last 48h that gbrain may not have yet. */
export function gatherRecentSources(options: RecentBufferOptions = {}): RecentSource[] {
  const notesDir = options.notesDir ?? KARWIKI_NOTES_DIR;
  const threadTitles = options.threadTitles ?? RECENT_THREAD_TITLES;
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - RECENT_WINDOW_MS;
  const sources: RecentSource[] = [];

  // Fresh "remember this" notes — the single most important source: they were
  // explicit asks to remember, and they're invisible to gbrain until ingest.
  try {
    for (const fileName of fs.readdirSync(notesDir)) {
      if (!fileName.endsWith(".md")) continue;
      const filePath = path.join(notesDir, fileName);
      try {
        const modifiedMs = fs.statSync(filePath).mtimeMs;
        if (modifiedMs < cutoffMs) continue;
        const text = fs.readFileSync(filePath, "utf8");
        sources.push({ label: "note", ts: modifiedMs, text });
      } catch {
        /* unreadable note — skip it */
      }
    }
  } catch {
    /* notes dir missing — fine, threads still count */
  }

  // Recent conversation across the voice + vision threads.
  try {
    for (const meta of listThreads()) {
      if (meta.provider !== "claude") continue;
      if (!threadTitles.includes(meta.title)) continue;
      const thread = getThread(meta.id);
      if (!thread) continue;
      const recentMessages = thread.messages
        .slice(-MAX_MESSAGES_PER_THREAD)
        .filter((message) => message.ts >= cutoffMs);
      for (const message of recentMessages) {
        const speaker = message.role === "user" ? getUserConfig().displayName : "Vidi";
        sources.push({
          label: meta.title,
          ts: message.ts,
          text: `${speaker}: ${message.text}`,
        });
      }
    }
  } catch {
    /* thread store unreadable — return whatever we have */
  }

  return sources;
}

/**
 * Pure relevance pick: score sources by how many distinct query words they
 * contain, keep the best few, freshest first among equals. Exported separately
 * so tests can exercise the scoring without a filesystem.
 */
export function pickRelevantSnippets(
  query: string,
  sources: RecentSource[],
  maxSnippets = MAX_SNIPPETS
): string | null {
  const queryWords = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3)
    )
  );
  if (queryWords.length === 0) return null;

  const scored = sources
    .map((source) => {
      const haystack = source.text.toLowerCase();
      const score = queryWords.filter((word) => haystack.includes(word)).length;
      return { source, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.source.ts - a.source.ts)
    .slice(0, maxSnippets);

  if (scored.length === 0) return null;

  return scored
    .map(({ source }) => {
      // H9: strip any leading forged role/control tokens from the ingested
      // note/conversation text before it becomes a prompt snippet. The whole
      // buffer is also fenced as untrusted at the voice-turn consumption site.
      const oneLine = stripLeadingControlTokens(source.text).replace(/\s+/g, " ").trim();
      const clipped =
        oneLine.length > MAX_SNIPPET_CHARS
          ? oneLine.slice(0, MAX_SNIPPET_CHARS - 1) + "…"
          : oneLine;
      return `- [${source.label}] ${clipped}`;
    })
    .join("\n");
}

/**
 * The voice-route entry point. Same tiny-transcript guard as autoRecall —
 * "yes" / "stop" carry no recall signal.
 */
export function recentBuffer(
  query: string,
  options: RecentBufferOptions = {}
): string | null {
  if (query.trim().split(/\s+/).length < 4) return null;
  try {
    return pickRelevantSnippets(query, gatherRecentSources(options));
  } catch {
    return null;
  }
}
