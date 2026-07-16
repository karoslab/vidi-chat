import fs from "node:fs";
import path from "node:path";

/**
 * The per-install data directory (T1.6).
 *
 * Everything the app persists lives under data/ — threads, the onboarded flag,
 * user-config.json, the profile, tokens, commitments, events. By default that
 * is `<cwd>/data`, matching the rest of the app's process.cwd()-relative
 * storage (and the tests, which chdir into a temp dir per case).
 *
 * VIDI_DATA_DIR overrides the base so a FRESH-INSTALL flow can be exercised
 * locally without touching real data:
 *
 *   VIDI_DATA_DIR=$(mktemp -d) npm run dev -- -p 4199
 *
 * points the whole install at an empty dir → no threads, no onboarded flag →
 * the first-run onboarding actually shows (Phase 0 step 6 / the P4.4
 * rehearsal). Unset → byte-identical to before.
 *
 * Resolved at CALL time (not memoized) so a test that sets the env var and a
 * caller that reads it see a consistent value; the env var is process-stable in
 * production so there's no per-call cost worth avoiding.
 */
/**
 * The LIVE repo data dir (this file is lib/data-dir.ts → ../data). Under the
 * test runner we must NEVER resolve here.
 *
 * Root cause (2026-07-07): an act-mode agent ran `npm test` from the repo root
 * with VIDI_DATA_DIR empty; the cwd fallback below resolved to this live dir and
 * test fixtures were batch-appended into data/commitments.jsonl and
 * data/quota.jsonl. Tests are supposed to isolate via a temp cwd (process.chdir)
 * or an explicit VIDI_DATA_DIR — but the fallback silently pointed a
 * forgot-to-isolate test at real data instead of failing.
 *
 * Computed lazily and only under the test sentinel (VIDI_TEST=1, set by the
 * `npm test` script) so production never even evaluates import.meta — a bundler
 * that leaves import.meta.dirname undefined can't break a live run, and the
 * guard degrades to a no-op if the path can't be resolved.
 */
function liveDataDir(): string | null {
  try {
    const dir = import.meta.dirname;
    if (!dir) return null;
    return path.resolve(dir, "..", "data");
  } catch {
    return null;
  }
}

export function dataDir(): string {
  const override = process.env.VIDI_DATA_DIR;
  if (typeof override === "string" && override.trim()) {
    const resolved = override.trim();
    // Test guard, defense-in-depth (2026-07-07): reject an EXPLICIT VIDI_DATA_DIR
    // that resolves to the live repo data/ under the test sentinel. This closes
    // the exact hole that let an act-mode `npm test` pollute live data:
    // lib/providers/claude.ts pins VIDI_DATA_DIR = dataDir() (the live dir) into
    // every act-mode Bash child, so a suite run INSIDE that sandbox inherited the
    // live dir through this override branch and never reached the cwd-fallback
    // guard below — every forgot-to-isolate test then wrote real data/. The
    // `npm test` script now strips VIDI_DATA_DIR (env -u); this guard is the
    // backstop for a direct `node --test` invocation that still carries the pin.
    if (process.env.VIDI_TEST === "1") {
      const live = liveDataDir();
      if (live && path.resolve(resolved) === live) {
        throw new Error(
          "vidi-chat tests must never use the live data dir (would pollute " +
            `${live}). An inherited VIDI_DATA_DIR pointed at it — run via ` +
            "`npm test` (which strips VIDI_DATA_DIR with env -u) or unset it. " +
            "See lib/data-dir.ts liveDataDir()."
        );
      }
    }
    return resolved;
  }
  const fallback = path.join(process.cwd(), "data");
  // Test guard: fail fast rather than write the live data dir. Only active under
  // the test sentinel; a test that lands here forgot to chdir to a temp dir or
  // set VIDI_DATA_DIR. (VIDI_DATA_DIR takes precedence above, so a properly
  // isolated test never reaches this check.)
  if (process.env.VIDI_TEST === "1") {
    const live = liveDataDir();
    if (live && path.resolve(fallback) === live) {
      throw new Error(
        "vidi-chat tests must never use the live data dir (would pollute " +
          `${live}). chdir to a temp dir — ` +
          "process.chdir(fs.mkdtempSync(...)) — or set VIDI_DATA_DIR before the " +
          "first dataDir()/dataPath() call. See lib/data-dir.ts liveDataDir()."
      );
    }
  }
  return fallback;
}

/** Convenience: a path under the data dir. */
export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}

/**
 * Phase 4a — H10. Harden the on-disk permissions of the per-install data.
 *
 * data/ holds PII (journal, threads, profile, quota, tokens) — gitignored, so
 * no egress, but on a shared Mac other local users could read a 0644 file. This
 * tightens data/ to 0700 (owner-only) and a specific file to 0600 (owner
 * read/write). Both are STRICTLY best-effort: a chmod failure (odd filesystem,
 * already-locked file) must never break the write it protects.
 */
export function ensureDataDirSecure(): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.chmodSync(dataDir(), 0o700);
  } catch {
    /* best-effort: a chmod/mkdir failure must never break a write */
  }
}

/**
 * Ensure data/ is 0700, then chmod the given file to 0600. Call AFTER writing/
 * appending the file (writeFileSync's `mode` only applies on creation, and
 * append files persist across runs, so an explicit chmod is the reliable path).
 * Fully best-effort.
 */
export function secureDataFile(filePath: string): void {
  ensureDataDirSecure();
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort: never break the write */
  }
}
