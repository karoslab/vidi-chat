import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPath } from "./data-dir.ts";

/**
 * the user's STANDING RULES — global working conventions — injected into the
 * system prompt of EVERY provider (Claude, Codex/ChatGPT, Grok) so they apply
 * regardless of which model a session runs on. This is the whole point: the same
 * rules text goes to all three providers (see the prepend call in each of
 * lib/providers/{claude,codex,grok}.ts).
 *
 * Two sources, concatenated in this order (both optional — a missing file is an
 * empty string, never an error):
 *   1. GLOBAL — ~/.claude/CLAUDE.md, the machine-wide Claude Code rules
 *      (interaction style, the "give me novice step-by-step" coaching rule, etc.).
 *      Resolved via os.homedir() so it's not a hardcoded /Users/... path.
 *   2. OVERLAY — data/USER_RULES.md, an optional per-install vidi-chat overlay,
 *      appended AFTER the global file.
 *
 * The combined text is capped at MAX_RULES_BYTES (~8KB) — a runaway rules file
 * must not blow out every turn's context. On truncation we log a warning and cut
 * at the cap.
 *
 * Light caching: each source is re-read only when its mtime (or existence)
 * changes, so a live edit to either file takes effect on the next turn without a
 * restart, but the steady state costs one stat per source per turn, not a read.
 */

/** Global rules file: the machine-wide Claude Code conventions. */
const globalRulesFile = () => path.join(os.homedir(), ".claude", "CLAUDE.md");

/** Optional per-install overlay, appended after the global file. */
const overlayRulesFile = () => dataPath("USER_RULES.md");

/** ~8KB cap on the injected block. */
export const MAX_RULES_BYTES = 8 * 1024;

/** Heading the block is delimited by in every provider's system prompt. */
export const USER_RULES_HEADING = "## standing rules (apply regardless of model)";

/**
 * Off switch. Default ON — the rules apply everywhere unless USER_RULES_ENABLED
 * is explicitly set to a falsey value ("0"/"false"/"no"/"off"). (Chose an env
 * flag over a settings-panel toggle: the panel wiring — a new EDITABLE field,
 * validation, and UI — is more than the ~1h budget; the env flag is the
 * documented power-user seam the rest of the app already uses.)
 */
export function userRulesEnabled(): boolean {
  const raw = process.env.USER_RULES_ENABLED;
  if (typeof raw === "string" && raw.trim()) {
    const v = raw.trim().toLowerCase();
    return !(v === "0" || v === "false" || v === "no" || v === "off");
  }
  return true;
}

interface CacheEntry {
  /** mtimeMs of the file at last read, or null when the file was absent. */
  mtimeMs: number | null;
  content: string;
}

const cache = new Map<string, CacheEntry>();

/**
 * Read a file with mtime-based caching: re-read only when the file's mtime
 * changed (or it appeared/disappeared). A missing/unreadable file caches as an
 * empty string so the miss isn't re-stat-read-thrashed either. Keyed by absolute
 * path so the global and overlay entries never collide.
 */
function readCached(file: string): string {
  let mtimeMs: number | null;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = null; // absent/unreadable
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.content;

  let content = "";
  if (mtimeMs !== null) {
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      content = ""; // race: disappeared between stat and read
    }
  }
  cache.set(file, { mtimeMs, content });
  return content;
}

/**
 * The raw combined rules text (global + overlay), trimmed and size-capped, with
 * NO heading. Empty string when both sources are missing/empty or the feature is
 * disabled. Exported for tests and for callers that want the body alone.
 */
export function loadUserRules(): string {
  if (!userRulesEnabled()) return "";
  const parts = [readCached(globalRulesFile()), readCached(overlayRulesFile())]
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";

  let combined = parts.join("\n\n");
  if (Buffer.byteLength(combined, "utf8") > MAX_RULES_BYTES) {
    // Truncate on a byte boundary (slice by bytes, then drop a possibly-split
    // trailing multibyte char via a lossy round-trip).
    const buf = Buffer.from(combined, "utf8").subarray(0, MAX_RULES_BYTES);
    combined = buf.toString("utf8").replace(/�+$/, "").trimEnd();
    console.warn(
      `[user-rules] combined rules exceed ${MAX_RULES_BYTES} bytes — truncated. ` +
        `Trim ${globalRulesFile()} or ${overlayRulesFile()} to inject the full text.`
    );
  }
  return combined;
}

/**
 * The delimited block to prepend to a provider's system prompt, or "" when there
 * are no rules (so callers can `[userRulesBlock(), persona].filter(Boolean)`).
 * Same content for every provider — that's the point of this module.
 */
export function userRulesBlock(): string {
  const body = loadUserRules();
  return body ? `${USER_RULES_HEADING}\n${body}` : "";
}

/** Test-only: drop the mtime cache so a case can rewrite a file and re-read. */
export function _resetUserRulesCache(): void {
  cache.clear();
}
