import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import { fenceUntrusted } from "./untrusted.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Shared cross-agent memory — a plain JSONL pool (CNVS's file-based approach,
 * which benchmarked better than Mem0/Letta with zero infra). Agents write
 * facts other agents should know via `vidictl remember`, and read them via
 * `vidictl recall`; a compact digest is injected into each agent's first
 * prompt so it starts with shared context without a tool call.
 */

export interface MemoryEntry {
  ts: number;
  agent: string; // who wrote it ("vidi" for the user-facing assistant)
  text: string;
  tags?: string[];
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/memory.jsonl.
const memoryFile = () => dataPath("memory.jsonl");

export function remember(text: string, agent = "vidi", tags?: string[]): MemoryEntry {
  // Tier-2 (S-redact): shared memory is ingested into gbrain (→ Brain sync),
  // so scrub secrets before they leave data/ on that path.
  const entry: MemoryEntry = {
    ts: Date.now(),
    agent,
    text: redactSecrets(text.slice(0, 2000)),
    tags,
  };
  try {
    fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
    fs.appendFileSync(memoryFile(), JSON.stringify(entry) + "\n");
  } catch {
    /* memory is best-effort; never break a turn */
  }
  return entry;
}

export function recall(query?: string, limit = 20): MemoryEntry[] {
  let entries: MemoryEntry[] = [];
  try {
    for (const line of fs.readFileSync(memoryFile(), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t));
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    return [];
  }
  if (query) {
    const q = query.toLowerCase();
    entries = entries.filter(
      (e) => e.text.toLowerCase().includes(q) || e.tags?.some((tag) => tag.toLowerCase().includes(q))
    );
  }
  return entries.slice(-limit);
}

/** Compact recent-memory digest for injection into an agent's first prompt. */
export function memoryDigest(limit = 8): string {
  const recent = recall(undefined, limit);
  if (recent.length === 0) return "";
  // H9: shared fleet memory is cross-agent ingested content. Tag each line by
  // author — "vidi" is the user-facing assistant, anything else is an
  // AGENT-authored fact — and fence the whole block as untrusted data so an
  // injected "ignore previous / do X" line another agent wrote can't drive this
  // agent's turn. The author tag lets the reader weight a user-authored fact
  // above an agent-authored one.
  const lines = recent
    .map((e) => {
      const origin = e.agent === "vidi" ? "user-authored" : `agent-authored: ${e.agent}`;
      return `- [${origin}] ${e.text}`;
    })
    .join("\n");
  return "Shared fleet memory (recent):\n" + fenceUntrusted("shared fleet memory", lines);
}
