import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../data-dir.ts";

/**
 * Browser Rails — Phase 1 config + gating (default OFF).
 *
 * This is a NEW TRUST SURFACE (like Builder mode was): letting the assistant
 * drive a real browser is a fresh capability that must be its OWN explicit
 * consent gate, not folded into any existing mode. The whole model:
 *
 *   - The capability is OFF until the user turns it on in Settings. There is no
 *     env default that flips it on, no "owner gets it free". Fail-closed.
 *   - v1 rails (enforced here + in tools.ts): a FRESH EPHEMERAL browser profile
 *     ONLY (never a real profile / cookies / logged-in session), a per-task
 *     DOMAIN ALLOWLIST the agent must declare and the user approves, NO
 *     downloads, NO form submission to non-allowlisted hosts, and a per-task
 *     page + wall-clock budget. Read primitives (screenshot, text) are primary.
 *   - Because there is never a real profile, credential exfiltration through the
 *     browser is impossible in v1 — there is nothing logged in to steal.
 *
 * The flag lives in its own file (browser-rails.json under data/), mirrors the
 * builder-mode.json pattern exactly, and — like builder-mode.json — is on the
 * SECRET_PATHS denylist so a tool-run agent can never flip it by writing the
 * file. The guarded /api/browser-rails route is the ONLY writer.
 */

/** File that persists the per-install opt-in. data/ is gitignored, per-install. */
const stateFile = () => path.join(dataDir(), "browser-rails.json");

export interface BrowserRailsState {
  /** Master switch. Default OFF. */
  on: boolean;
  /** ISO timestamp of the last change (audit breadcrumb). */
  at?: string;
}

/**
 * Read the opt-in live and fail-closed. A missing or corrupt file means OFF —
 * the capability must never turn itself on through an unreadable state file.
 * Env override (VIDI_BROWSER_RAILS=1/true/yes) exists for managed installs the
 * same way VIDI_ACT_OPT_IN does; anything else → the file → OFF.
 */
export function browserRailsEnabled(): boolean {
  const raw = process.env.VIDI_BROWSER_RAILS;
  if (typeof raw === "string" && raw.trim()) {
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return parsed?.on === true;
  } catch {
    return false;
  }
}

/** Persist the opt-in. The guarded route is the only caller. */
export function setBrowserRails(on: boolean): void {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ on: on === true, at: new Date().toISOString() }));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* permissions are best-effort on exotic filesystems */
  }
}

/**
 * Per-task rails budget. These are the runaway/quota guards: a task may open at
 * most `maxPages` navigations and run at most `wallClockMs` before the driver
 * refuses further work. Deliberately conservative for Phase 1.
 */
export const BROWSER_TASK_BUDGET = {
  /** Max navigations (browser_open calls) per task. */
  maxPages: 20,
  /** Wall-clock ceiling per task, in milliseconds (5 minutes). */
  wallClockMs: 5 * 60 * 1000,
} as const;

/**
 * Approximate on-disk cost of the browser component downloaded on FIRST enable
 * (Chromium via Playwright). Surfaced in the consent copy + design doc so we
 * never balloon the shipped customer payload silently. Kept as a string because
 * it is display copy, not a computed limit.
 */
export const BROWSER_DOWNLOAD_SIZE = "about 150 MB";
