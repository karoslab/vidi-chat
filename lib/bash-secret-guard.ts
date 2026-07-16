import path from "node:path";
import { getUserConfig } from "./user-config.ts";
import { matchesSecretPath } from "./write-file-jail.ts";
import { SECRET_PATHS } from "./providers/claude.ts";

/**
 * Phase 4a — P3 (threat-model B5). The Bash-lane secret-read guard.
 *
 * The act-mode Bash allowlist admits read tools by prefix — `Bash(cat *)`,
 * `Bash(head *)`, `Bash(tail *)`, `Bash(cp *)`, … — so the SECRET_PATHS denylist
 * (which binds only the Read/Edit/Write tools) never inspects a
 * `cat ~/.codex/auth.json`. That is the open credential-exfil lane B5 describes.
 *
 * This guard closes it by matching the PROTECTED PATH SET anywhere in the
 * command string — NOT a binary allow/deny list. Matching the path (not the
 * binary) is the robust choice: `cat`, `less`, `base64`, `dd if=…`, `strings`,
 * `xxd`, or a plain `> ~/.ssh/…` redirect all resolve to the same secret path
 * and are all caught, without having to enumerate every reader that exists.
 *
 * Two layers:
 *   1. FILE-level — a token that resolves to a SECRET_PATHS glob match
 *      (`cat ~/.codex/auth.json`). Reuses the exact glob→RegExp matcher the
 *      write-file jail uses (matchesSecretPath), so the Bash lane and the
 *      write/confirm lane can never drift on what counts as a secret.
 *   2. DIRECTORY-level — a token that names the secret's CONTAINING directory
 *      (or an ancestor of a whole-directory secret): `cp -r ~/.ssh ~/Downloads`
 *      recursively copies the private keys to a freely-readable place with one
 *      allowlisted command, then `cat ~/Downloads/x/id_rsa` reads them. The
 *      file-level check misses this because every credential-DIR glob is
 *      `dir/**` (needs a child segment) and the data/ globs are bare filenames,
 *      so naming the parent dir slipped past. Blocks `cp -r ~/.ssh`,
 *      `cp -r ~/.codex`, `cp -r ~/.aws`, `rsync -a ~/.config/gcloud …`,
 *      `cp -r data …`, `cp -r ~/.claude …`, and copies of $HOME itself.
 *
 * Pure and exported so it is unit-testable without a shell; the PreToolUse hook
 * (hooks/deny-secret-read.ts) is a thin stdin→decision wrapper over it.
 */

function homeDir(): string {
  return process.env.HOME || getUserConfig().homeDir;
}

/** Expand a leading `~` and any `$HOME` / `${HOME}` in a shell token to the
 *  absolute home path, so `cat ~/.codex/auth.json` and `cat $HOME/.codex/...`
 *  both resolve to the real credential path the denylist knows. */
function expandHome(token: string): string {
  let t = token;
  if (t === "~" || t.startsWith("~/")) t = homeDir() + t.slice(1);
  return t.replace(/\$\{HOME\}/g, homeDir()).replace(/\$HOME/g, homeDir());
}

/**
 * Break a command into candidate path-shaped tokens. This is deliberately NOT a
 * shell parser.
 *
 * Quotes AND escaping backslashes are STRIPPED, not split on: the shell treats
 * `~/.co"dex"/auth.json`, `~/.co'dex'/auth.json`, `~/".codex"/auth.json`, and
 * `~/.co\dex/auth.json` (a backslash before an ordinary char is a no-op escape)
 * all as the single path `~/.codex/auth.json`, so an injected act-mode payload
 * could sprinkle quotes or backslashes into a secret path to slip past a
 * splitter (the B5 / P8 evasion). Removing `"` `'` `\` first collapses those
 * back to the real path BEFORE tokenizing. Then split on the metacharacters that
 * separate words, pipeline stages, redirects, and `option=value` pairs. `$` `{`
 * `}` are intentionally NOT separators so `${HOME}` survives to expandHome.
 * (Backslash-escaped whitespace joins two words into one path in a real shell;
 * stripping the backslash instead splits them — a MISS, never a false block, and
 * no SECRET_PATHS entry contains a space, so real coverage is unchanged. This
 * mirrors the existing quote behavior, which splits quoted spaces the same way.)
 */
function pathTokens(command: string): string[] {
  return command
    .replace(/["'\\]/g, "")
    .split(/[\s|;&<>`]+|=/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * A protected DIRECTORY derived from a SECRET_PATHS glob. Either:
 *   - `absolute` — a whole-directory secret anchored to a fixed path (`~/.ssh`,
 *     `~/.config/gcloud`, …): copying it OR any ancestor of it exposes secrets;
 *     copying anything inside it does too (the whole dir is secret).
 *   - `floatingSegments` — a match-anywhere sensitive dir from a globstar glob
 *     (`data`, `data/threads`, `.claude`): a token whose path ENDS in exactly
 *     these segments IS that dir, so `cp -r data` grabs the tokens inside. We do
 *     NOT block ancestors of a floating dir — that would flag the whole
 *     workspace, which legitimately contains a `data/` dir.
 */
interface ProtectedDir {
  absolute: string | null;
  floatingSegments: string[] | null;
}

/** Derive the protected directories from SECRET_PATHS. A dir is protected only
 *  when the glob makes a whole DIRECTORY secret (`dir/**`) or names a file inside
 *  a sensitive per-install dir (a globstar glob like data/<file> or .claude/<file>).
 *  A lone secret FILE in an otherwise-normal dir (keys.rtf, .env*, .proxy-secret)
 *  does NOT make its parent a protected dir — else naming the workspace root
 *  would be blocked. Recomputed per call so a test's HOME override is honored. */
function protectedSecretDirs(): ProtectedDir[] {
  const out: ProtectedDir[] = [];
  for (const glob of SECRET_PATHS) {
    const floating = glob.startsWith("**/");
    let g = glob;
    if (g.startsWith("~/")) g = path.join(homeDir(), g.slice(2));
    else if (g.startsWith("//")) g = g.slice(1);
    else if (floating) g = g.slice(3);

    // Leading run of wildcard-free segments = the fixed portion.
    const segs = g.split("/").filter(Boolean);
    const fixed: string[] = [];
    let endsWithGlobstar = false;
    for (const s of segs) {
      if (s === "**") { endsWithGlobstar = true; break; }
      if (s.includes("*")) break;
      fixed.push(s);
    }
    if (fixed.length === 0) continue;

    // Whole-dir secret (`dir/**`) → the fixed run IS the secret dir. A terminal
    // file (`…/control-token`, keys.rtf) → the containing dir is fixed minus the
    // last segment. Only whole-dir and floating-with-a-container qualify.
    if (!endsWithGlobstar && !floating) continue; // anchored lone file (keys.rtf) — file-level only
    const dirSegs = endsWithGlobstar ? fixed : fixed.slice(0, -1);
    if (dirSegs.length === 0) continue; // e.g. `**/.env*` — bare filename, no dir

    if (floating) out.push({ absolute: null, floatingSegments: dirSegs });
    else out.push({ absolute: "/" + dirSegs.join("/"), floatingSegments: null });
  }
  return out;
}

/** True when `ancestor` is `descendant` or a parent directory of it. */
function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const a = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return descendant.startsWith(a);
}

/** True when a resolved absolute token would expose a protected directory:
 *  it equals / is inside / is an ancestor of a whole-dir secret, or it IS a
 *  match-anywhere sensitive dir (its trailing segments equal one). */
function tokenHitsProtectedDir(resolved: string): boolean {
  const segs = resolved.split(path.sep).filter(Boolean);
  for (const dir of protectedSecretDirs()) {
    if (dir.absolute) {
      // Ancestor-or-equal (copying it/its parent grabs the dir) OR inside it
      // (the whole dir is secret).
      if (isAncestorOrEqual(resolved, dir.absolute) || isAncestorOrEqual(dir.absolute, resolved)) {
        return true;
      }
    } else if (dir.floatingSegments) {
      const suffix = dir.floatingSegments;
      if (suffix.length <= segs.length) {
        const tail = segs.slice(segs.length - suffix.length);
        if (suffix.every((s, i) => s === tail[i])) return true;
      }
    }
  }
  return false;
}

export interface BashSecretVerdict {
  blocked: boolean;
  /** The offending raw token, so the deny reason / journal can name it. */
  match?: string;
}

/**
 * True when a Bash command references any SECRET_PATHS-protected file OR the
 * directory that holds one (a `cp -r ~/.ssh …` recursive-copy exfil). Fail-open
 * on nothing to inspect (empty / non-string command) and on an individual token
 * that can't be resolved — a guard that throws would break the turn, and the
 * Read/Edit/Write denylist plus the write-file jail remain as the other layers.
 */
export function bashCommandTouchesSecret(command: unknown): BashSecretVerdict {
  if (typeof command !== "string" || !command.trim()) return { blocked: false };
  for (const token of pathTokens(command)) {
    try {
      const expanded = expandHome(token);
      if (matchesSecretPath(expanded) || tokenHitsProtectedDir(path.resolve(expanded))) {
        return { blocked: true, match: token };
      }
    } catch {
      /* an unresolvable token is treated as no-match, never a throw */
    }
  }
  return { blocked: false };
}
