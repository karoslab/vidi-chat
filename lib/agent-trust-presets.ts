import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_ROOT } from "./workspace.ts";

/**
 * Agent trust-marker pre-writing (ported from Orca's agent-trust-presets.ts).
 *
 * Before vidi-chat spawns a coding-agent CLI in a workspace, pre-write that
 * CLI's own on-disk "this folder is trusted" artifact — the same file the CLI
 * writes AFTER the user accepts its "Do you trust the files in this folder?"
 * prompt. Pre-writing it means a fresh install never lands the spawned child in
 * an interactive trust gate on its first turn.
 *
 * Why this matters here (honest scope): vidi-chat spawns every CLI
 * NON-INTERACTIVELY (`claude -p`, `codex exec`, `grok -p`), stdin ignored, so
 * there is no injected keystroke for a trust menu to eat (Orca's original
 * failure mode). On THIS machine the workspace root is already trusted for
 * claude, so the calls no-op. The payoff is the SECOND-USER / fresh-install
 * path (a non-owner second user's Mac): there the workspace is untrusted, and a first-run trust
 * gate — or trust-gated project-settings/MCP loading — would otherwise change
 * how the spawned CLI behaves versus the owner's box. This keeps the two installs
 * byte-identical without a human clicking a TUI prompt.
 *
 * Which CLIs get a preset (write-less-code — only what vidi-chat launches AND
 * what has a folder-trust artifact):
 *   - claude  → <CLAUDE_CONFIG_DIR | ~>/.claude.json, projects[<abs>]
 *               .hasTrustDialogAccepted = true. Verified against Claude Code
 *               2.1.201 (the running project entries carry this exact key).
 *   - codex   → <CODEX_HOME | ~/.codex>/config.toml, [projects."<abs>"]
 *               trust_level = "trusted". Verified against codex-cli 0.144.1
 *               (its own /trust flow writes this exact block; several are
 *               already present in the live config.toml).
 *   - grok is INTENTIONALLY excluded: it runs under `--sandbox strict` in a
 *     throwaway temp jail (SANDBOX_CWD), never in the workspace, and has no
 *     per-folder trust artifact — its confinement is kernel-sandbox + a
 *     one-tool allowlist (see lib/providers/grok.ts), which this must not touch.
 *
 * SAFETY BOUND: every function refuses — throws — any directory that is not the
 * vidi-chat workspace root or a path inside it (assertTrustable). vidi-chat only
 * ever launches claude/codex with cwd = WORKSPACE_ROOT, so a caller can never
 * widen trust to an arbitrary folder, and trust is never granted globally — only
 * to the exact directory the agent is about to run in. This composes with, and
 * weakens nothing in, the existing action-path jail (the CLI allow/deny lists,
 * SECRET_PATHS, and the write-file jail): folder trust only governs the CLI's
 * own first-run prompt, not what the spawned agent is permitted to do.
 */

/** Canonicalize a path the way both CLIs do before comparing trust paths: realpath
 *  its EXISTING prefix (so a symlinked ancestor like macOS's /var → /private/var
 *  is resolved) and re-append any not-yet-created tail. Without resolving the
 *  existing prefix, a real workspace root (/private/var/…) would fail to contain a
 *  not-yet-created subdir still written as /var/…. Falls back to the lexical
 *  resolve if realpath throws. */
function canonicalize(p: string): string {
  const resolved = path.resolve(p);
  const tail: string[] = [];
  let cur = resolved;
  while (true) {
    if (existsSync(cur)) {
      try {
        const real = realpathSync.native(cur);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch {
        break;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached the filesystem root
    tail.push(path.basename(cur));
    cur = parent;
  }
  return resolved;
}

/** True when `dir` is the workspace root itself or strictly inside it. */
export function isTrustableWorkspace(dir: string): boolean {
  const root = canonicalize(WORKSPACE_ROOT);
  const target = canonicalize(dir);
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The single choke every preset passes through. Returns the canonical absolute
 * path when it is inside the workspace root; THROWS otherwise. This is the
 * enforcement point for "only ever mark a directory vidi-chat itself is about
 * to launch an agent in" — a caller cannot pre-trust an arbitrary folder.
 */
function assertTrustable(dir: string): string {
  const target = canonicalize(dir);
  if (!isTrustableWorkspace(target)) {
    throw new Error(
      `agent-trust-presets: refusing to mark "${dir}" trusted — it is outside ` +
        `the vidi-chat workspace root (${WORKSPACE_ROOT}). Trust is only ever ` +
        `granted to the directory an agent is about to launch in.`
    );
  }
  return target;
}

/** Atomic write: tmp file in the same dir + rename, so a crash mid-write can
 *  never leave a half-written ~/.claude.json or config.toml (either would brick
 *  the CLI). Random suffix avoids a cross-process race on rapid relaunches. */
function writeFileAtomically(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`);
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, filePath);
}

/** Escape a string for a TOML basic (double-quoted) string. macOS paths won't
 *  contain these, but escape defensively so a path with a quote/backslash can
 *  never break out of the header. */
function escapeTomlBasicString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

const REGEXP_SPECIALS = new Set([
  ".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "*",
]);
function escapeRegExpChar(ch: string): string {
  return REGEXP_SPECIALS.has(ch) ? "\\" + ch : ch;
}
function escapeRegExp(value: string): string {
  return [...value].map(escapeRegExpChar).join("");
}

/**
 * Pre-mark `workspaceDir` trusted for the `claude` CLI.
 *
 * Claude Code keeps per-project trust in <config-dir>/.claude.json under
 * projects["<abs>"].hasTrustDialogAccepted. `configDir` mirrors the provider's
 * per-account CLAUDE_CONFIG_DIR (lib/providers/claude.ts): the marker must land
 * in the SAME config dir the spawned CLI will read, or it wouldn't be seen.
 * Undefined/blank → the default ~/.claude.json.
 *
 * Idempotent (skips when already accepted) and non-destructive: a corrupted or
 * unreadable .claude.json is left untouched — it is the CLI's/user's to repair,
 * and clobbering it would lose global CLI state (history, auth, other projects).
 */
export function markClaudeWorkspaceTrusted(
  workspaceDir: string,
  configDir?: string
): void {
  const abs = assertTrustable(workspaceDir);
  const home =
    configDir && configDir.trim()
      ? configDir.trim()
      : process.env.HOME || os.homedir();
  const configPath = path.join(home, ".claude.json");

  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      } else {
        return; // unexpected shape — never overwrite it
      }
    }
  } catch {
    return; // corrupted JSON — the CLI/user owns the fix; refuse to clobber
  }

  const projects =
    config.projects && typeof config.projects === "object" && !Array.isArray(config.projects)
      ? (config.projects as Record<string, Record<string, unknown>>)
      : {};
  const entry =
    projects[abs] && typeof projects[abs] === "object" && !Array.isArray(projects[abs])
      ? (projects[abs] as Record<string, unknown>)
      : {};
  if (entry.hasTrustDialogAccepted === true) return; // idempotent

  entry.hasTrustDialogAccepted = true;
  projects[abs] = entry;
  config.projects = projects;
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** True when config.toml already declares a `[projects."<abs>"]` table (any
 *  trust level) on its own line. When it does we leave it alone: appending a
 *  duplicate table is invalid TOML, and an existing entry is either already
 *  trusted or a user's explicit decision we must not override. */
function hasCodexProjectTable(content: string, abs: string): boolean {
  const header = `[projects."${escapeTomlBasicString(abs)}"]`;
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(header)}[ \\t]*(?:#.*)?$`, "m");
  return pattern.test(content);
}

/**
 * Pre-mark `workspaceDir` trusted for the `codex` CLI.
 *
 * Codex keeps project trust in <codex-home>/config.toml under
 * [projects."<abs>"] trust_level = "trusted". `codexHome` mirrors an optional
 * CODEX_HOME (the provider uses the default today); undefined/blank → ~/.codex.
 *
 * Minimal + byte-preserving: it ONLY appends a fresh table when none exists for
 * this exact path (idempotent, and it never rewrites/parses the rest of the
 * file, so user comments, key order, and other tables survive untouched). If a
 * table for the path already exists it is left as-is — never duplicated, never
 * flipped from a user-set untrusted.
 */
export function markCodexWorkspaceTrusted(
  workspaceDir: string,
  codexHome?: string
): void {
  const abs = assertTrustable(workspaceDir);
  const home =
    codexHome && codexHome.trim()
      ? codexHome.trim()
      : path.join(process.env.HOME || os.homedir(), ".codex");
  const configPath = path.join(home, "config.toml");

  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (hasCodexProjectTable(existing, abs)) return; // idempotent

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = `[projects."${escapeTomlBasicString(abs)}"]${eol}trust_level = "trusted"${eol}`;
  const separator =
    existing.length === 0
      ? ""
      : existing.endsWith(eol + eol)
        ? ""
        : existing.endsWith(eol)
          ? eol
          : eol + eol;
  writeFileAtomically(configPath, `${existing}${separator}${block}`);
}
