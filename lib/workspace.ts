import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the workspace root — the directory that
 * holds vidi-chat alongside its siblings (Brain, vidi, ops, …).
 *
 * Historically these paths were hardcoded as "the workspace root", which
 * only kept resolving after the workspace-root path migration because the legacy workspace path
 * is a temporary compat symlink. Deriving the root instead makes vidi-chat
 * portable and survives the symlink's removal.
 *
 * Resolution order (first match wins):
 *   1. process.env.VIDI_WORKSPACE_ROOT — explicit override for tests /
 *      relocation. Trusted as-is, no validation.
 *   2. Derived from this module's own location, IF it passes the sanity check.
 *      workspace.ts lives at <root>/vidi-chat/lib/workspace.ts on source runs
 *      (tests, scripts), so the root is two directories up — independent of
 *      process.cwd(). BUT in the production bundle Next inlines this module
 *      into a chunk under <distDir>/server/…, so import.meta.url no longer
 *      points at lib/ and the derivation lands somewhere inside the dist dir.
 *   3. Derived from process.cwd(), IF it passes the sanity check. The launchd
 *      service (com.vidi.vidichat) and `npm start` both run with
 *      WorkingDirectory <root>/vidi-chat, so cwd's parent is the root. This is
 *      the branch the production bundle is expected to take.
 *
 * Sanity check = the candidate actually contains a vidi-chat/package.json.
 * instrumentation.ts logs the resolved root once at boot and screams if no
 * candidate validated — do not remove that log; it is the only runtime signal
 * that this resolution broke (tests import the source module and cannot see
 * the bundled-chunk failure mode).
 */
function looksLikeWorkspaceRoot(candidate: string): boolean {
  return existsSync(path.join(candidate, "vidi-chat", "package.json"));
}

function resolveWorkspaceRoot(): { root: string; via: string; valid: boolean } {
  const override = process.env.VIDI_WORKSPACE_ROOT;
  if (override && override.trim()) {
    return { root: path.resolve(override.trim()), via: "env", valid: true };
  }
  // <root>/vidi-chat/lib/workspace.ts → dirname = <root>/vidi-chat/lib
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // up out of lib → <root>/vidi-chat, up again → <root>
  const fromModule = path.resolve(moduleDir, "..", "..");
  if (looksLikeWorkspaceRoot(fromModule)) {
    return { root: fromModule, via: "module-location", valid: true };
  }
  const fromCwd = path.resolve(process.cwd(), "..");
  if (looksLikeWorkspaceRoot(fromCwd)) {
    return { root: fromCwd, via: "cwd", valid: true };
  }
  // Nothing validated — keep the module derivation (old behavior) so callers
  // still get a deterministic path, but flag it for the boot check.
  return { root: fromModule, via: "module-location (UNVALIDATED)", valid: false };
}

const resolved = resolveWorkspaceRoot();

export const WORKSPACE_ROOT = resolved.root;

/** How WORKSPACE_ROOT was resolved + whether it passed the sanity check —
 *  logged once at boot by instrumentation.ts. */
export const WORKSPACE_ROOT_RESOLUTION = resolved;

/**
 * Build an absolute path under the workspace root from path segments.
 * e.g. workspacePath("Brain", "wiki", "<owner>-model.md")
 *   → "<root>/Brain/wiki/<owner>-model.md"
 */
export function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}
