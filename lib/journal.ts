import fs from "node:fs";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Action journal — one JSONL line per tool call Vidi makes in act mode.
 * data/journal.jsonl (gitignored, like all of data/). The persona tells Vidi
 * this file exists so she can read her own history back when asked
 * "what did you do".
 */

export interface JournalEntry {
  ts: number;
  threadId: string;
  tool: string;
  /** Brief human-readable input summary: bash command string, file path, etc. */
  summary: string;
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/journal.jsonl.
const journalFile = () => dataPath("journal.jsonl");

/** Past this size, trim to the newest MAX_LINES on the next append — the
 *  journal is a recent-history drawer, not an archive. */
const MAX_BYTES = 1_000_000;
const MAX_LINES = 2000;

export function appendJournal(entry: JournalEntry) {
  try {
    // Tier-2 (S-redact): the summary is a tool input/command string that can
    // carry a secret (a logged Authorization header, one of vidi's own tokens).
    // Scrub it before it lands in the browser-readable journal.
    const safe: JournalEntry = { ...entry, summary: redactSecrets(entry.summary) };
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.appendFileSync(journalFile(), JSON.stringify(safe) + "\n");
    secureDataFile(journalFile()); // H10: 0600 journal (PII) + 0700 data/
    if (fs.statSync(journalFile()).size > MAX_BYTES) {
      const keep = fs
        .readFileSync(journalFile(), "utf8")
        .trimEnd()
        .split("\n")
        .slice(-MAX_LINES);
      const tmp = journalFile() + ".tmp";
      fs.writeFileSync(tmp, keep.join("\n") + "\n");
      fs.renameSync(tmp, journalFile());
    }
  } catch {
    /* journaling must never break a turn */
  }
}

/** Latest `limit` entries, newest first. */
export function readJournal(limit = 50): JournalEntry[] {
  try {
    const lines = fs.readFileSync(journalFile(), "utf8").split("\n");
    const out: JournalEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
