import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` / `~user` in a filesystem path to an absolute home path.
 *
 * Nothing in the write-file or terminal path used to expand the tilde, so the
 * single most likely model emission for a home-dir target — "~/Desktop/notes.txt"
 * or a "~/workspace" cwd — resolved relative to CWD ("<cwd>/~/Desktop/…") and
 * either silently missed the write-jail short-circuit or crashed a terminal
 * spawn against a literal, nonexistent "~" directory (audit findings 11, 13).
 *
 * The three forms handled:
 *   - "~"           → the current user's home
 *   - "~/rest"      → <home>/rest
 *   - "~user/rest"  → the sibling home <dirname(home)>/user + "/rest"
 *
 * `~user` can't be resolved from /etc/passwd portably, but on macOS every
 * account's home is a sibling of the current user's under /Users, so this
 * resolves the common case; an unknown user simply resolves to a path the
 * write-jail then refuses, which is the safe direction. A path without a leading
 * "~" is returned unchanged.
 */
export function expandTilde(inputPath: string): string {
  if (inputPath === "~") return homeDir();
  if (inputPath.startsWith("~/")) return homeDir() + inputPath.slice(1);
  if (inputPath.startsWith("~")) {
    const firstSlashIndex = inputPath.indexOf("/");
    const username =
      firstSlashIndex === -1
        ? inputPath.slice(1)
        : inputPath.slice(1, firstSlashIndex);
    const remainder = firstSlashIndex === -1 ? "" : inputPath.slice(firstSlashIndex);
    // A bare "~" with no username was already handled above; guard the empty
    // case anyway so we never join a home sibling named "".
    if (!username) return inputPath;
    return path.join(path.dirname(homeDir()), username) + remainder;
  }
  return inputPath;
}

/**
 * The current process user's home. Resolved from the process (HOME, else the
 * OS's real home) — never a hardcoded path — so the expansion is correct on a
 * second user's Mac, mirroring lib/write-file-jail.ts's homeDir().
 */
function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/**
 * The inverse of `expandTilde` for DISPLAY only: collapse a leading home-dir
 * prefix back to "~" so a customer never sees an absolute filesystem path like
 * "/Users/<owner>/…". Never use the result for filesystem work — it is a label.
 * A path outside the home dir is returned unchanged.
 */
export function homeRelative(inputPath: string): string {
  const home = homeDir();
  if (inputPath === home) return "~";
  if (inputPath.startsWith(home + path.sep)) return "~" + inputPath.slice(home.length);
  return inputPath;
}
