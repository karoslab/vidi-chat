import fs from "node:fs";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";
import {
  appBuildId,
  bumpDiagUsage,
  diagCategoryCounts,
  readDiagUsage,
  readRecentDiag,
  recordDiag,
  sessionSameCategoryCount,
  type DiagCategory,
  type DiagEntry,
} from "./diag-ledger.ts";
import { readVoiceKey } from "./voice-tier.ts";
import { WORKER_BASE } from "./worker-url.ts";

/**
 * Feedback + weekly-health-summary delivery (DIAGNOSTICS + FEEDBACK loop,
 * 2026-07-11).
 *
 * HARD CONSTRAINT — zero silent egress: NOTHING here sends without an explicit
 * user trigger. `sendFeedback` runs only when the user hits Send in the compose
 * screen (after seeing the exact scrubbed bundle). `maybeSendWeeklySummary`
 * runs only when the user has flipped the weekly-summary consent toggle ON (a
 * FAIL-CLOSED read) and 7 days have passed. Both go through the owner's
 * vidi-proxy worker /feedback route, using this install's existing key.
 */

/** The worker feedback relay (same worker as TTS; server-side only). */
const WORKER_FEEDBACK_URL = `${WORKER_BASE}/feedback`;

/** ask-on-error: after this many same-category failures in a session, offer
 *  (once) to send a report. Never auto-sends; never re-offers a category twice
 *  in a day. */
export const ASK_ON_ERROR_THRESHOLD = 3;

/** Seven days between weekly summaries; retry attempts throttled to 6h so a
 *  down webhook is retried "next window" without hammering. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_RETRY_THROTTLE_MS = 6 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Install key (seam: dedicated install key later, voice-key today)           */
/* -------------------------------------------------------------------------- */

/**
 * This install's key for the vidi-proxy worker. Designed as an "install key"
 * lookup with a seam for a future dedicated key: an explicit `data/install-key`
 * file wins if present (bare trimmed value, same on-disk shape voice-tier.ts
 * uses); else today's source is `data/voice-key` via lib/voice-tier.ts's
 * readVoiceKey() — the SAME reader the voice picker uses (storeVoiceKey() writes
 * the trimmed value + "\n", 0600; readVoiceKey() reads it back trimmed, no
 * `KEY=value` wrapper), so this can never drift from the canonical format.
 * Returns the key or null when the install has never stored one. The worker
 * knows the key's LABEL — the app never sends it.
 */
export function getInstallKey(): string | null {
  try {
    const value = fs.readFileSync(dataPath("install-key"), "utf8").trim();
    if (value) return value;
  } catch {
    /* no dedicated install-key file yet — fall back to the voice-key source */
  }
  return readVoiceKey();
}

/** Does this install have a key to send reports with? */
export function hasInstallKey(): boolean {
  return getInstallKey() !== null;
}

/* -------------------------------------------------------------------------- */
/* Report bundle (the exact scrubbed payload the preview shows)               */
/* -------------------------------------------------------------------------- */

export interface ReportBundle {
  generatedAt: number;
  appBuild: string;
  /** Active-day count proxy for "sessions". */
  sessions: number;
  errorsByCategory: Record<string, number>;
  recentErrors: Array<Pick<DiagEntry, "ts" | "category" | "message">>;
  usage: Record<string, number>;
}

/**
 * Assemble the technical report from the LEDGER ONLY. Every field is already
 * scrubbed (the ledger scrubs on write) or is a pure count — so a report can
 * never contain chat content, a file path, or a token. This is exactly what the
 * compose screen renders for preview before the user sends it.
 */
export function buildReportBundle(now: number = Date.now()): ReportBundle {
  const usage = readDiagUsage();
  return {
    generatedAt: now,
    appBuild: appBuildId(),
    sessions: usage["sessions"] ?? 0,
    errorsByCategory: diagCategoryCounts(),
    recentErrors: readRecentDiag(15).map((e) => ({
      ts: e.ts,
      category: e.category,
      message: e.message,
    })),
    usage,
  };
}

/** Render the bundle as the readable plain-text block the preview shows and the
 *  worker forwards. Customer words, no dashes. */
export function renderReportText(bundle: ReportBundle): string {
  const lines: string[] = [];
  lines.push(`App build: ${bundle.appBuild}`);
  lines.push(`Sessions (active days): ${bundle.sessions}`);

  const errorEntries = Object.entries(bundle.errorsByCategory);
  if (errorEntries.length > 0) {
    lines.push("Errors by type:");
    for (const [category, count] of errorEntries) {
      lines.push(`  ${category}: ${count}`);
    }
  } else {
    lines.push("Errors by type: none recorded");
  }

  const usageEntries = Object.entries(bundle.usage).filter(([k]) => k !== "sessions");
  if (usageEntries.length > 0) {
    lines.push("Feature usage:");
    for (const [name, count] of usageEntries) {
      lines.push(`  ${name}: ${count}`);
    }
  }

  if (bundle.recentErrors.length > 0) {
    lines.push("Most recent errors:");
    for (const entry of bundle.recentErrors) {
      const when = new Date(entry.ts).toISOString();
      lines.push(`  [${when}] ${entry.category}: ${entry.message}`);
    }
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* ask-on-error policy                                                        */
/* -------------------------------------------------------------------------- */

const ASK_STATE_FILE = () => dataPath("feedback-ask-state.json");

function readAskState(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(ASK_STATE_FILE(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    /* no file */
  }
  return {};
}

function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Should we surface the gentle "want to send the owner a report?" prompt for this
 * category right now? True only when the session has seen >= threshold
 * same-category failures AND we haven't already offered that category today.
 * Reading only — call `markCategoryOffered` when the prompt is actually shown.
 */
export function shouldOfferReport(category: DiagCategory, now: number = Date.now()): boolean {
  if (sessionSameCategoryCount(category) < ASK_ON_ERROR_THRESHOLD) return false;
  const lastOfferedDay = readAskState()[category];
  return lastOfferedDay !== dayStamp(now);
}

/** Mark this category as offered today so we never nag twice in a day. */
export function markCategoryOffered(category: DiagCategory, now: number = Date.now()): void {
  try {
    const state = readAskState();
    state[category] = dayStamp(now);
    fs.mkdirSync(path.dirname(ASK_STATE_FILE()), { recursive: true });
    fs.writeFileSync(ASK_STATE_FILE(), JSON.stringify(state, null, 2));
    secureDataFile(ASK_STATE_FILE());
  } catch {
    /* best-effort */
  }
}

/* -------------------------------------------------------------------------- */
/* Send (user-triggered)                                                      */
/* -------------------------------------------------------------------------- */

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "no-key" | "delivery-failed" };

/**
 * POST the user's feedback to the worker. `includeReport` attaches the scrubbed
 * bundle. Returns a structured result the route turns into plain language. No
 * key stored → { ok:false, reason:"no-key" } (the UI points the user at
 * Settings). This is only ever called from the feedback route, which is
 * requireWriteAuth-gated and only reached from the compose screen's Send.
 */
export async function sendFeedback(args: {
  text: string;
  includeReport: boolean;
  kind?: "feedback" | "weekly-summary";
  now?: number;
}): Promise<SendResult> {
  const key = getInstallKey();
  if (!key) return { ok: false, reason: "no-key" };

  const body: { text: string; report?: string; kind: "feedback" | "weekly-summary" } = {
    text: args.text.trim(),
    kind: args.kind ?? "feedback",
  };
  if (args.includeReport) {
    body.report = renderReportText(buildReportBundle(args.now ?? Date.now()));
  }

  try {
    const response = await fetch(WORKER_FEEDBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vidi-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, reason: "delivery-failed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "delivery-failed" };
  }
}

/* -------------------------------------------------------------------------- */
/* Weekly health summary (opt-in, consented egress)                           */
/* -------------------------------------------------------------------------- */

const CONSENT_FILE = () => dataPath("feedback-consent.json");
const SUMMARY_STATE_FILE = () => dataPath("feedback-state.json");

/**
 * Is the weekly health summary turned ON? FAIL-CLOSED: only an explicit
 * `{ weeklySummary: true }` returns true; a missing/corrupt file, a read error,
 * or any other shape returns false. This is the consented-egress gate — it must
 * never fail open.
 */
export function weeklySummaryConsent(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONSENT_FILE(), "utf8"));
    return parsed && typeof parsed === "object" && parsed.weeklySummary === true;
  } catch {
    return false; // fail-closed
  }
}

/** Set the weekly-summary consent flag. */
export function setWeeklySummaryConsent(enabled: boolean): void {
  fs.mkdirSync(path.dirname(CONSENT_FILE()), { recursive: true });
  fs.writeFileSync(CONSENT_FILE(), JSON.stringify({ weeklySummary: !!enabled }, null, 2));
  secureDataFile(CONSENT_FILE());
}

interface SummaryState {
  lastSummaryAt?: number;
  lastAttemptAt?: number;
  lastActivityDay?: string;
}

function readSummaryState(): SummaryState {
  try {
    const parsed = JSON.parse(fs.readFileSync(SUMMARY_STATE_FILE(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed as SummaryState;
  } catch {
    /* no file */
  }
  return {};
}

function writeSummaryState(state: SummaryState): void {
  try {
    fs.mkdirSync(path.dirname(SUMMARY_STATE_FILE()), { recursive: true });
    fs.writeFileSync(SUMMARY_STATE_FILE(), JSON.stringify(state, null, 2));
    secureDataFile(SUMMARY_STATE_FILE());
  } catch {
    /* best-effort */
  }
}

export interface WeeklyDigest {
  /** Compact one-line stat row for the Discord post. */
  text: string;
  /** JSON string of COUNTS ONLY — no message text, no paths. */
  report: string;
}

/**
 * Build the weekly digest from the LEDGER ONLY, as COUNTS ONLY. Deliberately
 * excludes error message text and recent-error detail (unlike the on-demand
 * report bundle) — the weekly summary reports numbers, never content. So it can
 * carry: session count, errors-by-category counts, feature-usage counters, and
 * the app build. No path, no message, no token can appear.
 */
export function buildWeeklyDigest(now: number = Date.now()): WeeklyDigest {
  const usage = readDiagUsage();
  const errorsByCategory = diagCategoryCounts();
  const sessions = usage["sessions"] ?? 0;

  const digest = {
    generatedAt: new Date(now).toISOString(),
    appBuild: appBuildId(),
    sessions,
    errorsByCategory,
    usage,
  };

  const errorSummary =
    Object.entries(errorsByCategory)
      .map(([category, count]) => `${category} ${count}`)
      .join(", ") || "none";
  const tts = usage["tts.premium"] ?? 0;
  const ttsLocal = usage["tts.local"] ?? 0;
  const text =
    `${sessions} sessions · errors: ${errorSummary} · ` +
    `tts ${tts + ttsLocal} (local ${ttsLocal}/premium ${tts}) · v${digest.appBuild}`;

  return { text, report: JSON.stringify(digest, null, 2) };
}

export type WeeklySummaryOutcome =
  | { sent: true }
  | { sent: false; reason: "no-consent" | "too-soon" | "throttled" | "no-key" | "delivery-failed" };

/**
 * Send the weekly summary IF consent is on AND >= 7 days since the last one.
 * Called lazily from app activity (there is no separate scheduler in this repo).
 * Failure is SILENT locally: it records a route-error in the ledger and does NOT
 * advance lastSummaryAt (so the next window retries) but DOES set lastAttemptAt
 * so a down webhook is retried at most every 6h, never nagging. Returns the
 * outcome for tests/telemetry; callers treat it as fire-and-forget.
 */
export async function maybeSendWeeklySummary(now: number = Date.now()): Promise<WeeklySummaryOutcome> {
  if (!weeklySummaryConsent()) return { sent: false, reason: "no-consent" };

  const state = readSummaryState();
  if (state.lastSummaryAt && now - state.lastSummaryAt < WEEK_MS) {
    return { sent: false, reason: "too-soon" };
  }
  if (state.lastAttemptAt && now - state.lastAttemptAt < SUMMARY_RETRY_THROTTLE_MS) {
    return { sent: false, reason: "throttled" };
  }

  const key = getInstallKey();
  if (!key) {
    // No key → can't send; record the attempt so we don't retry-spam, stay silent.
    writeSummaryState({ ...state, lastAttemptAt: now });
    return { sent: false, reason: "no-key" };
  }

  const digest = buildWeeklyDigest(now);
  try {
    const response = await fetch(WORKER_FEEDBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vidi-key": key },
      body: JSON.stringify({ text: digest.text, report: digest.report, kind: "weekly-summary" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      recordDiag("route-error", `weekly summary send failed (${response.status})`, now);
      writeSummaryState({ ...state, lastAttemptAt: now });
      return { sent: false, reason: "delivery-failed" };
    }
    writeSummaryState({ ...state, lastSummaryAt: now, lastAttemptAt: now });
    return { sent: true };
  } catch {
    recordDiag("route-error", "weekly summary send failed (network)", now);
    writeSummaryState({ ...state, lastAttemptAt: now });
    return { sent: false, reason: "delivery-failed" };
  }
}

/**
 * Note app activity: count an active day (a proxy for "sessions") and, if the
 * weekly summary is due, send it. Called from the activity ping route. The
 * session bump dedupes per calendar day so the count is active-days, not raw
 * pings.
 */
export async function noteAppActivity(now: number = Date.now()): Promise<WeeklySummaryOutcome> {
  const state = readSummaryState();
  const today = dayStamp(now);
  if (state.lastActivityDay !== today) {
    bumpDiagUsage("sessions");
    writeSummaryState({ ...state, lastActivityDay: today });
  }
  return maybeSendWeeklySummary(now);
}
