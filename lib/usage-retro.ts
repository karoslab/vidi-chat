import fs from "node:fs";
import { readQuota, type QuotaEntry } from "./quota.ts";
import { readDiagUsage } from "./diag-ledger.ts";
import { dataPath } from "./data-dir.ts";

/**
 * RETRO USAGE — read-only retrospective aggregation over the usage data this
 * install ALREADY records, so the owner can see and optimize spend/routing.
 *
 * Zero new telemetry: this module only READS existing files and never writes.
 * Sources (all local, no network egress):
 *   - data/quota.jsonl   — one line per completed provider turn (lib/quota.ts):
 *                          ts, provider, model, mode, tokens, costUsd, numTurns.
 *                          The primary source: per-day + per-model turns/tokens.
 *   - data/diag-usage.json — flat cumulative feature counters (lib/diag-ledger):
 *                          tts.local + tts.premium (TTS calls). CUMULATIVE only,
 *                          not per-day — the counter has no timestamp.
 *   - data/update.log    — the updater's dated text log (lib/updater.ts). We
 *                          count "update complete" lines as applied updates,
 *                          bucketed by their ISO timestamp.
 *
 * costUsd is the CLI-reported API-equivalent cost, not money spent (subscription
 * auth). There is no hard numeric quota cap recorded anywhere — Claude Max is a
 * rolling window, not a token allowance — so we report rolling consumption
 * (5h / 7d) rather than "used vs cap".
 */

/** Day bucket key, UTC, YYYY-MM-DD — deterministic across timezones/tests. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface UsageBucket {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface DayRow extends UsageBucket {
  day: string;
}

export interface ModelRow extends UsageBucket {
  model: string;
  provider: string;
  /** Turns on this model as a share (0..1) of all turns. */
  share: number;
}

export interface UpdateRow {
  day: string;
  count: number;
}

export interface RetroTts {
  /** Successful premium (worker) TTS calls. Cumulative, not per-day. */
  premium: number;
  /** Local system-voice TTS calls. Cumulative, not per-day. */
  local: number;
  total: number;
}

export interface RetroAggregate {
  /** Window covered, in days. */
  days: number;
  /** Inclusive UTC day range actually seen in the data, or null when empty. */
  range: { from: string; to: string } | null;
  totals: UsageBucket;
  byDay: DayRow[];
  byModel: ModelRow[];
  tts: RetroTts;
  updates: { total: number; byDay: UpdateRow[] };
  /** Rolling quota consumption (no hard cap is recorded — see module note). */
  quota: {
    last5h: UsageBucket;
    last7d: UsageBucket;
  };
  takeaways: string[];
}

function emptyBucket(): UsageBucket {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

function addEntry(b: UsageBucket, e: QuotaEntry): void {
  b.turns += 1;
  b.inputTokens += e.inputTokens ?? 0;
  b.outputTokens += e.outputTokens ?? 0;
  b.cacheReadTokens += e.cacheReadTokens ?? 0;
  b.cacheCreationTokens += e.cacheCreationTokens ?? 0;
  b.costUsd += e.costUsd ?? 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function roundBucket<T extends UsageBucket>(b: T): T {
  b.costUsd = round4(b.costUsd);
  return b;
}

// Models whose per-turn cost is high enough that routing short turns down is
// worth suggesting. Heuristic by name — the big Anthropic/OpenAI/xAI tiers.
const BIG_MODEL = /opus|gpt-5\.|grok-4|composer/i;

// A "short" turn: little output produced. On a big model these are the cheapest
// wins to route down to a smaller model.
const SHORT_TURN_OUTPUT = 60;

/** Count applied-update timestamps out of the updater's text log. */
export function parseUpdateLog(raw: string): UpdateRow[] {
  const byDay = new Map<string, number>();
  for (const line of raw.split("\n")) {
    // Lines look like: [2026-07-12T10:00:00.000Z] update complete; restarting
    if (!/update complete/i.test(line)) continue;
    const m = line.match(/^\[([^\]]+)\]/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isNaN(t)) continue;
    const d = dayKey(t);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  return [...byDay.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function computeTakeaways(
  totals: UsageBucket,
  byModel: ModelRow[],
  shortTurnsOnBig: number,
  tts: RetroTts
): string[] {
  const out: string[] = [];
  if (totals.turns === 0) {
    out.push("No usage has been recorded yet. Run a few turns and check back.");
    return out;
  }

  const top = byModel[0];
  if (top && top.share >= 0.7 && BIG_MODEL.test(top.model)) {
    out.push(
      `${Math.round(top.share * 100)} percent of turns ran on the big model (${top.model}). ` +
        "Consider routing short turns down to a smaller model to save quota."
    );
  } else if (top && top.share >= 0.8) {
    out.push(
      `${Math.round(top.share * 100)} percent of turns ran on ${top.model}. ` +
        "Your routing is concentrated on one model, which is fine if it is the right size for the work."
    );
  }

  if (shortTurnsOnBig >= 5) {
    out.push(
      `${shortTurnsOnBig} short turns ran on a big model. ` +
        "Short turns rarely need the big model, so those are easy wins to route down."
    );
  }

  // Cost concentration: if one model is most of the reported cost, name it.
  if (totals.costUsd > 0) {
    const byCost = [...byModel].sort((a, b) => b.costUsd - a.costUsd);
    const costTop = byCost[0];
    if (costTop && costTop.costUsd / totals.costUsd >= 0.6) {
      out.push(
        `${Math.round((costTop.costUsd / totals.costUsd) * 100)} percent of the reported cost came from ${costTop.model}. ` +
          "That is the model to watch if you want to bring spend down."
      );
    }
  }

  // Cache health: a high cache-read share means prompt caching is doing its job.
  const billedIn = totals.inputTokens + totals.cacheCreationTokens;
  if (totals.cacheReadTokens > 0 && billedIn > 0) {
    const ratio = totals.cacheReadTokens / (totals.cacheReadTokens + billedIn);
    if (ratio >= 0.5) {
      out.push(
        `${Math.round(ratio * 100)} percent of input tokens were served from cache. ` +
          "Prompt caching is working well and keeping input cost low."
      );
    }
  }

  if (tts.premium > 0) {
    out.push(
      `${tts.premium} premium voice replies have been spoken (cumulative). ` +
        "Premium voice uses the shared proxy quota, so watch this if it climbs."
    );
  }

  if (out.length === 0) {
    out.push("Usage looks balanced. No routing changes stand out right now.");
  }
  return out;
}

/**
 * Pure aggregation — takes already-read inputs so it can be exercised directly
 * against fixtures. `now` and `days` bound the window; entries outside it are
 * assumed already filtered by the caller, but we bucket whatever is passed.
 */
export function aggregate(
  entries: QuotaEntry[],
  diagUsage: Record<string, number>,
  updateLogRaw: string,
  now: number,
  days: number
): RetroAggregate {
  const totals = emptyBucket();
  const dayMap = new Map<string, DayRow>();
  const modelMap = new Map<string, ModelRow>();
  let shortTurnsOnBig = 0;
  let minDay: string | null = null;
  let maxDay: string | null = null;

  for (const e of entries) {
    addEntry(totals, e);

    const d = dayKey(e.ts);
    if (minDay === null || d < minDay) minDay = d;
    if (maxDay === null || d > maxDay) maxDay = d;

    let row = dayMap.get(d);
    if (!row) {
      row = { day: d, ...emptyBucket() };
      dayMap.set(d, row);
    }
    addEntry(row, e);

    const model = e.model ?? "unknown";
    const key = `${e.provider}/${model}`;
    let mrow = modelMap.get(key);
    if (!mrow) {
      mrow = { model, provider: e.provider, share: 0, ...emptyBucket() };
      modelMap.set(key, mrow);
    }
    addEntry(mrow, e);

    if (BIG_MODEL.test(model) && (e.outputTokens ?? 0) < SHORT_TURN_OUTPUT) {
      shortTurnsOnBig += 1;
    }
  }

  const byDay = [...dayMap.values()]
    .map(roundBucket)
    .sort((a, b) => a.day.localeCompare(b.day)) as DayRow[];

  const byModel = [...modelMap.values()]
    .map((m) => {
      roundBucket(m);
      m.share = totals.turns > 0 ? m.turns / totals.turns : 0;
      return m;
    })
    .sort((a, b) => b.turns - a.turns);

  roundBucket(totals);

  const tts: RetroTts = {
    premium: diagUsage["tts.premium"] ?? 0,
    local: diagUsage["tts.local"] ?? 0,
    total: (diagUsage["tts.premium"] ?? 0) + (diagUsage["tts.local"] ?? 0),
  };

  const updatesByDay = parseUpdateLog(updateLogRaw);
  const updates = {
    total: updatesByDay.reduce((s, r) => s + r.count, 0),
    byDay: updatesByDay,
  };

  // Rolling quota windows straight off the entries (5h / 7d).
  const q5 = emptyBucket();
  const q7 = emptyBucket();
  const fiveHoursAgo = now - 5 * 3600_000;
  const sevenDaysAgo = now - 7 * 24 * 3600_000;
  for (const e of entries) {
    if (e.ts >= sevenDaysAgo) addEntry(q7, e);
    if (e.ts >= fiveHoursAgo) addEntry(q5, e);
  }

  return {
    days,
    range: minDay && maxDay ? { from: minDay, to: maxDay } : null,
    totals,
    byDay,
    byModel,
    tts,
    updates,
    quota: { last5h: roundBucket(q5), last7d: roundBucket(q7) },
    takeaways: computeTakeaways(totals, byModel, shortTurnsOnBig, tts),
  };
}

/** Read the updater log best-effort — a missing file yields "". */
function readUpdateLog(): string {
  try {
    return fs.readFileSync(dataPath("update.log"), "utf8");
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* On-demand build with a tiny in-process cache (no cron).                    */
/* -------------------------------------------------------------------------- */

let cache: { key: string; at: number; value: RetroAggregate } | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * Build the retro aggregate from disk. Cheap on-demand read with a 30s
 * in-process cache keyed by the requested window, so a dashboard poll does not
 * re-parse the ledgers on every call.
 */
export function buildRetro(days = 30, now = Date.now()): RetroAggregate {
  const key = String(days);
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const since = now - days * 24 * 3600_000;
  const entries = readQuota(since);
  const value = aggregate(entries, readDiagUsage(), readUpdateLog(), now, days);
  cache = { key, at: now, value };
  return value;
}

/** Test-only: drop the in-process cache. */
export function _resetRetroCache(): void {
  cache = null;
}
