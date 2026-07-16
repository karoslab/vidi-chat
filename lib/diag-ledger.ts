import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPath, secureDataFile } from "./data-dir.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Local-first diagnostics ledger (DIAGNOSTICS + FEEDBACK loop, 2026-07-11).
 *
 * A tiny, bounded, on-disk record of things that WENT WRONG on this install —
 * so a non-owner second user can say "something's broken" and Vidi can show
 * a plain "recent errors" list, and so an opt-in weekly health summary can count
 * them. It is OBSERVE-ONLY: capture points sit alongside the existing error
 * surfaces and never change what those surfaces do or return.
 *
 * HARD CONSTRAINT — zero silent egress: this file only ever WRITES to data/. It
 * never sends anything anywhere. Everything that leaves the machine is triggered
 * explicitly by the user through lib/feedback.ts with a visible preview.
 *
 * NEVER stored: chat content, user file paths, or tokens. Every message is run
 * through scrubDiagMessage BEFORE it touches disk — it strips $HOME / absolute
 * paths, long hex/base64 runs (ids, tokens), and the generic secret shapes
 * lib/redact.ts already knows. So the ledger contains no secrets BY
 * CONSTRUCTION — which is why it is gitignored but NOT on the SECRET_PATHS
 * denylist (there is nothing secret in it to wall off from the agent).
 *
 * Bounded: at most DIAG_MAX_ENTRIES lines (oldest dropped), each message capped
 * at DIAG_MAX_MESSAGE_CHARS. Every write is best-effort and never throws — a
 * diagnostics failure must never break the turn it was observing.
 */

/** The closed set of failure classes the ledger records. `journey-verify-fail`
 *  captures a journey step's verify() throwing (lib/journey/registry.ts runOne)
 *  — a genuine bug, distinct from an ordinary "not connected yet" result. */
export type DiagCategory =
  | "provider-fail"
  | "route-error"
  | "journey-verify-fail"
  | "spawn-crash"
  | "tts-fail";

export interface DiagEntry {
  /** Epoch ms. */
  ts: number;
  category: DiagCategory;
  /** Plain, scrubbed one-line message — never chat content / paths / tokens. */
  message: string;
  /** App build id / version this happened on. */
  build: string;
}

/** Keep the ledger small — it is a rolling window, not an audit log. */
export const DIAG_MAX_ENTRIES = 200;
/** One error line should never be a wall of text (a raw stack). */
export const DIAG_MAX_MESSAGE_CHARS = 400;

const LEDGER_FILE = () => dataPath("diag-ledger.jsonl");
const USAGE_FILE = () => dataPath("diag-usage.json");

/* -------------------------------------------------------------------------- */
/* App build id                                                               */
/* -------------------------------------------------------------------------- */

const APP_VERSION_FALLBACK = "0.1.0";

/** Read the package version once, relative to THIS module (not cwd — tests
 *  chdir to temp dirs), falling back to a constant. */
function readPackageVersion(): string {
  try {
    const here = import.meta.dirname;
    if (!here) return APP_VERSION_FALLBACK;
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, "..", "package.json"), "utf8")
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : APP_VERSION_FALLBACK;
  } catch {
    return APP_VERSION_FALLBACK;
  }
}

/** The build id to stamp on entries: an explicit VIDI_BUILD_ID wins (a deploy
 *  can set it), else the package version. */
export function appBuildId(): string {
  const explicit = process.env.VIDI_BUILD_ID;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return readPackageVersion();
}

/* -------------------------------------------------------------------------- */
/* Scrub                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Strip everything that must never land in the ledger from a raw error string:
 *   - absolute home / user paths ($HOME, /Users/<name>/…, /home/<name>/…),
 *   - long hex runs (>=16, ids / hashes / hex tokens),
 *   - long base64-ish runs (>=24, opaque tokens),
 *   - then the generic secret shapes lib/redact.ts recognizes (Bearer, sk-, …).
 * Collapses whitespace/newlines to one line and caps the length. A benign
 * message ("usage limit reached") passes through essentially unchanged.
 */
export function scrubDiagMessage(raw: unknown): string {
  let out = typeof raw === "string" ? raw : String(raw ?? "");

  // Home dir first (covers a homeDir that isn't under /Users, e.g. a test tmp).
  try {
    const home = os.homedir();
    if (home && home.length >= 3) {
      out = out.split(home).join("<path>");
    }
  } catch {
    /* homedir unavailable — the generic path pattern below still fires */
  }

  // Any remaining absolute user path → placeholder (macOS + Linux shapes).
  out = out.replace(/\/(?:Users|home)\/[^\s'":,)]+/g, "<path>");

  // Long hex runs (hashes, hex tokens, keyIds) and base64-ish opaque runs.
  out = out.replace(/\b[0-9a-fA-F]{16,}\b/g, "<hex>");
  out = out.replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "<token>");

  // Defense in depth: the shared secret-shape redactor (Bearer, sk-, ghp_, …).
  out = redactSecrets(out);

  // One line, collapsed, capped.
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > DIAG_MAX_MESSAGE_CHARS) {
    out = out.slice(0, DIAG_MAX_MESSAGE_CHARS - 1) + "…";
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* In-session counters (for ask-on-error)                                     */
/* -------------------------------------------------------------------------- */

// Counts per category since this process started. A "session" for the
// ask-on-error prompt is the running app process — simple and stable, and reset
// on restart, matching "N failures within a session".
const sessionCategoryCounts = new Map<DiagCategory, number>();

/** How many times `category` has been recorded since the process started. */
export function sessionSameCategoryCount(category: DiagCategory): number {
  return sessionCategoryCounts.get(category) ?? 0;
}

/** Test-only: clear the in-memory session counters. */
export function _resetSessionCounts(): void {
  sessionCategoryCounts.clear();
}

/* -------------------------------------------------------------------------- */
/* Record + read                                                              */
/* -------------------------------------------------------------------------- */

/** Read the ledger lines (oldest first). Best-effort — a missing/corrupt file
 *  yields an empty list. */
function readLedgerLines(): DiagEntry[] {
  try {
    const raw = fs.readFileSync(LEDGER_FILE(), "utf8");
    const entries: DiagEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && typeof parsed.category === "string") {
          entries.push(parsed as DiagEntry);
        }
      } catch {
        /* skip a corrupt line */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Record one diagnostic event. Scrubs the message, stamps the build id, appends
 * to the bounded ledger (rewriting to keep the last DIAG_MAX_ENTRIES), and bumps
 * the in-session counter. Fully best-effort — never throws into the caller.
 */
export function recordDiag(
  category: DiagCategory,
  rawMessage: unknown,
  now: number = Date.now()
): void {
  // In-session counter bumps even if the disk write fails, so ask-on-error still
  // works on a read-only disk.
  sessionCategoryCounts.set(category, (sessionCategoryCounts.get(category) ?? 0) + 1);

  try {
    const entry: DiagEntry = {
      ts: now,
      category,
      message: scrubDiagMessage(rawMessage),
      build: appBuildId(),
    };
    const entries = readLedgerLines();
    entries.push(entry);
    const bounded = entries.slice(-DIAG_MAX_ENTRIES);
    fs.mkdirSync(path.dirname(LEDGER_FILE()), { recursive: true });
    fs.writeFileSync(LEDGER_FILE(), bounded.map((e) => JSON.stringify(e)).join("\n") + "\n");
    secureDataFile(LEDGER_FILE());
  } catch {
    /* best-effort: a diagnostics write must never break the observed turn */
  }
}

/**
 * Classify a raw provider/CLI error: a missing-binary / spawn failure is
 * `spawn-crash`; everything else provider-side is `provider-fail`. Mirrors the
 * recognizers in lib/provider-error.ts so the ledger's category matches the
 * plain-language message the user saw. Exported so the ask-on-error policy can
 * ask about the SAME category that was just recorded.
 */
export function classifyProviderCategory(rawMessage: unknown): DiagCategory {
  const lower = (typeof rawMessage === "string" ? rawMessage : String(rawMessage ?? "")).toLowerCase();
  return lower.includes("failed to spawn") || lower.includes("enoent")
    ? "spawn-crash"
    : "provider-fail";
}

/** Classify then record a provider/CLI error. */
export function recordProviderDiag(rawMessage: unknown, now: number = Date.now()): void {
  recordDiag(classifyProviderCategory(rawMessage), rawMessage, now);
}

/** The most recent `limit` entries, newest first. */
export function readRecentDiag(limit = 20): DiagEntry[] {
  const entries = readLedgerLines();
  return entries.slice(-limit).reverse();
}

/** Count of entries per category across the whole (bounded) ledger. */
export function diagCategoryCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of readLedgerLines()) {
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Feature-usage counters (for the weekly health summary)                     */
/* -------------------------------------------------------------------------- */

/** Read the flat usage-counter map. Best-effort — missing/corrupt → empty. */
export function readDiagUsage(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    /* no file / corrupt */
  }
  return {};
}

/**
 * Increment a named feature-usage counter (e.g. "tts.premium", "desk.approvals",
 * "sessions"). These are COUNTS ONLY — never any content — so the weekly summary
 * can report usage numbers without touching a message or a path. Best-effort.
 */
export function bumpDiagUsage(name: string, amount = 1): void {
  try {
    const usage = readDiagUsage();
    usage[name] = (usage[name] ?? 0) + amount;
    fs.mkdirSync(path.dirname(USAGE_FILE()), { recursive: true });
    fs.writeFileSync(USAGE_FILE(), JSON.stringify(usage, null, 2));
    secureDataFile(USAGE_FILE());
  } catch {
    /* best-effort */
  }
}
