import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT } from "./workspace.ts";
import { SECRET_PATHS } from "./providers/claude.ts";
import { expandTilde } from "./expand-tilde.ts";

/**
 * Phase 4a — H4. The path jail for the `write-file` confirm executor.
 *
 * Background (B1+B2 in the threat model): confirm park/approve are now
 * control/session-token gated with a per-command nonce (see THREAT_MODEL B1).
 * This module is the *payload* backstop for write-file: even a compromised
 * local principal that can approve may only write inside the jail, never a
 * credential/dotfile/system path.
 *
 * The rule (a target is refused unless ALL hold):
 *   (a) it resolves INSIDE {workspace root, Desktop, Downloads} — the same
 *       three roots the CLI's --add-dir write jail allows; AND
 *   (b) it does NOT match any SECRET_PATHS deny glob (keys.rtf, .env*,
 *       data/*-token, accounts.json, …) — those live under an allowed root but
 *       must never be written; AND
 *   (c) it is NOT a dotfile directly in $HOME (belt-and-suspenders — a dotfile
 *       in $HOME is already outside the three roots, but the rule is explicit
 *       so a future root addition can't silently expose ~/.zshrc).
 *
 * Pure and exported so the jail is unit-testable without touching disk.
 */

function homeDir(): string {
  // SECURITY (audit section E1): the write-jail root must NEVER fall back to a
  // foreign hardcoded path. getUserConfig().homeDir defaults to the owner's
  // home dir — using it here would, on a second user's Mac with HOME somehow
  // unset, jail writes to the owner's home (a wrong, cross-user root). Resolve
  // from the process instead: launchd sets HOME per-user; os.homedir() reads
  // the OS's real home for the current process user as the fail-closed
  // fallback. Both equal the owner's home on their machine (behavior
  // unchanged) and the second user's on theirs.
  return process.env.HOME || os.homedir();
}

/** The three roots a confirmed write may land under (mirrors the CLI --add-dir
 *  write jail: workspace + Desktop + Downloads). */
function allowedWriteRoots(): string[] {
  const home = homeDir();
  return [
    path.resolve(WORKSPACE_ROOT),
    path.resolve(home, "Desktop"),
    path.resolve(home, "Downloads"),
  ];
}

/** True when `resolved` is `root` itself or strictly inside it. */
function isInside(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Translate one SECRET_PATHS deny glob into a RegExp against an absolute path.
 * The glob dialect used in claude.ts's denylist:
 *   - a leading "/" then an absolute path  → matched from the start (the
 *     "//<abs>" CLI form is authored as "/<abs>"; we compare the tail abs path),
 *   - "~/…"   → home-relative,
 *   - "**"    → any run of characters (including path separators),
 *   - "*"     → any run of characters within a single path segment,
 *   - everything else is a literal.
 * Anchored so a "globstar data hands-token" pattern matches any path ENDING in
 * data/hands-token.
 */
/** Escape one literal character for safe inclusion in a RegExp source. Kept as
 *  a named helper (not an inline regex with `${}`) so node's native TS stripper
 *  doesn't misparse a `${` inside a regex literal. */
const REGEXP_SPECIALS = new Set([
  ".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\",
]);
function escapeRegExpChar(ch: string): string {
  return REGEXP_SPECIALS.has(ch) ? "\\" + ch : ch;
}

function secretGlobToRegExp(glob: string): RegExp {
  let g = glob;
  if (g.startsWith("~/")) {
    g = path.join(homeDir(), g.slice(2));
  } else if (g.startsWith("//")) {
    // CLI "//abs" absolute form → the real absolute path.
    g = g.slice(1);
  }
  // Build the pattern piece by piece so "**" and "*" get distinct translations.
  let pattern = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        pattern += "[\\s\\S]*"; // ** — crosses path separators
        i++;
      } else {
        pattern += "[^/]*"; // * — within one segment
      }
    } else {
      pattern += escapeRegExpChar(ch);
    }
  }
  // If the glob began with "**", allow it to match from anywhere (no leading
  // anchor). Otherwise anchor at the start. Always anchor the end.
  const anchoredStart = glob.startsWith("**") ? "" : "^";
  return new RegExp(`${anchoredStart}${pattern}$`);
}

/** True when the absolute path matches any SECRET_PATHS deny glob. */
export function matchesSecretPath(absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  for (const glob of SECRET_PATHS) {
    try {
      if (secretGlobToRegExp(glob).test(resolved)) return true;
    } catch {
      /* a malformed glob never widens the jail — treat as no-match */
    }
  }
  return false;
}

/** True when the path is a dotfile directly in $HOME (e.g. ~/.zshrc). A dotDIR
 *  like ~/.ssh is covered by the allowlist + secret globs; this catches the
 *  bare top-level dotfiles a future allowed-root addition might expose. */
function isHomeDotfile(resolved: string): boolean {
  const home = path.resolve(homeDir());
  if (path.dirname(resolved) !== home) return false;
  return path.basename(resolved).startsWith(".");
}

export interface WriteJailResult {
  allowed: boolean;
  /** Plain-language reason when refused (safe to speak verbatim). */
  reason?: string;
}

/**
 * Decide whether a confirmed write-file may target `filePath`. Returns
 * { allowed: true } or { allowed: false, reason } with a plain-language reason.
 */
export function checkWriteFileTarget(filePath: string): WriteJailResult {
  const trimmed = (filePath ?? "").trim();
  if (!trimmed) return { allowed: false, reason: "I need a file path to write." };
  // Expand a leading "~"/"~user" BEFORE the absolute/jail checks (audit finding
  // 13). Nothing expanded the tilde, so "~/Desktop/notes.txt" — an explicitly
  // ALLOWED dir, and the single most likely model emission for a home file —
  // failed path.isAbsolute() and was refused as "relative" AFTER the human
  // approved it. Expanded, it resolves to a real absolute path the jail can judge.
  const raw = expandTilde(trimmed);
  if (!path.isAbsolute(raw)) {
    return {
      allowed: false,
      reason: "I can only write to a full file path, not a relative one.",
    };
  }
  const resolved = path.resolve(raw);

  // (a) allowlist — must be inside one of the three write-jail roots.
  const insideAnAllowedRoot = allowedWriteRoots().some((root) =>
    isInside(resolved, root)
  );
  if (!insideAnAllowedRoot) {
    return {
      allowed: false,
      reason:
        "I can only save files in your workspace, Desktop, or Downloads — that path is somewhere else.",
    };
  }

  // (b) secret denylist — even inside an allowed root, never a credential/token.
  if (matchesSecretPath(resolved)) {
    return {
      allowed: false,
      reason: "That looks like a protected or secret file — I won't write there.",
    };
  }

  // (c) belt-and-suspenders: never a bare dotfile in $HOME.
  if (isHomeDotfile(resolved)) {
    return {
      allowed: false,
      reason: "I won't write to a hidden system file in your home folder.",
    };
  }

  return { allowed: true };
}
