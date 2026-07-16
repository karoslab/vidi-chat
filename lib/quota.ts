import fs from "node:fs";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";

/**
 * Usage ledger — one JSONL line per completed provider turn, parsed from the
 * CLIs' own result events (claude: result.usage / total_cost_usd; codex:
 * turn.completed.usage). Written by the providers themselves so every path —
 * chat, voice, and the future loops/fleet — is covered without route changes.
 *
 * Purpose: a week of measured ground truth replaces quota guesswork before
 * any autonomous mode ships. costUsd is the CLI-reported API-equivalent cost,
 * not money spent (subscription auth) — it's the comparable unit for "how hot
 * is the Max window".
 */

export interface QuotaEntry {
  ts: number;
  provider: string;
  threadId: string;
  model?: string | null;
  mode?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/quota.jsonl.
const quotaFile = () => dataPath("quota.jsonl");

/** Remove ledger lines older than daysToKeep days. */
export function pruneQuota(daysToKeep = 30): void {
  try {
    const cutoff = Date.now() - daysToKeep * 24 * 3600_000;
    const raw = fs.readFileSync(quotaFile(), "utf8");
    const kept = raw
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          return (JSON.parse(trimmed) as QuotaEntry).ts >= cutoff;
        } catch {
          return false;
        }
      })
      .join("\n");
    // Atomic swap: a plain overwrite here can clobber a line another process
    // (dev server sharing data/) appended between our read and write.
    const tmp = quotaFile() + ".tmp";
    fs.writeFileSync(tmp, kept ? kept + "\n" : "");
    fs.renameSync(tmp, quotaFile());
  } catch {
    /* pruning must never break a turn */
  }
}

// Track the last prune date (YYYY-MM-DD) so we prune at most once per day.
let lastPruneDate = "";

export function appendQuota(entry: QuotaEntry) {
  try {
    fs.mkdirSync(path.dirname(quotaFile()), { recursive: true });
    fs.appendFileSync(quotaFile(), JSON.stringify(entry) + "\n");
    secureDataFile(quotaFile()); // H10: 0600 quota ledger + 0700 data/
  } catch {
    /* the ledger must never break a turn */
  }
  // Opportunistically prune once per calendar day.
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastPruneDate) {
    lastPruneDate = today;
    pruneQuota();
  }
}

/** Entries newer than sinceMs, oldest first. */
export function readQuota(sinceMs = 0, limit = 5000): QuotaEntry[] {
  try {
    const out: QuotaEntry[] = [];
    for (const line of fs.readFileSync(quotaFile(), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const e: QuotaEntry = JSON.parse(trimmed);
        if (e.ts >= sinceMs) out.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

export interface QuotaWindow {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  byProvider: Record<
    string,
    { turns: number; outputTokens: number; costUsd: number }
  >;
}

function windowFor(entries: QuotaEntry[]): QuotaWindow {
  const w: QuotaWindow = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    byProvider: {},
  };
  for (const e of entries) {
    w.turns++;
    w.inputTokens += e.inputTokens ?? 0;
    w.outputTokens += e.outputTokens ?? 0;
    w.cacheReadTokens += e.cacheReadTokens ?? 0;
    w.cacheCreationTokens += e.cacheCreationTokens ?? 0;
    w.costUsd += e.costUsd ?? 0;
    const p = (w.byProvider[e.provider] ??= {
      turns: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    p.turns++;
    p.outputTokens += e.outputTokens ?? 0;
    p.costUsd += e.costUsd ?? 0;
  }
  w.costUsd = Math.round(w.costUsd * 10000) / 10000;
  for (const p of Object.values(w.byProvider)) {
    p.costUsd = Math.round(p.costUsd * 10000) / 10000;
  }
  return w;
}

/** Claude Max quota windows: rolling 5 hours and rolling 7 days. */
export function summarizeQuota(now = Date.now()): {
  last5h: QuotaWindow;
  last7d: QuotaWindow;
} {
  const week = readQuota(now - 7 * 24 * 3600_000);
  const fiveHours = week.filter((e) => e.ts >= now - 5 * 3600_000);
  return { last5h: windowFor(fiveHours), last7d: windowFor(week) };
}
