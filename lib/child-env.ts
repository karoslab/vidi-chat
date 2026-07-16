/**
 * Minimal allowlisted environment for the CLI child processes (Tier-2 S-env).
 *
 * The provider spawns the local `claude` / `codex` binaries. Passing the full
 * `process.env` hands every secret the vidi-chat service holds — proxy keys,
 * cloud credentials, ntfy topics, whatever launchd/the shell exported — to a
 * process that then runs model-directed Bash. One injected `cat $SOME_SECRET`
 * or a compromised sub-tool exfiltrates them. The CLIs authenticate off the
 * local filesystem (~/.claude, ~/.codex, or CLAUDE_CONFIG_DIR), NOT off env, so
 * they need only a small set of standard operational vars to run.
 *
 * Policy: start from nothing; copy an allowlist of non-secret operational vars
 * that are present; then layer the caller's explicit childEnv (fleet stamps
 * like VIDI_AGENT_ID) on top. Notably ANTHROPIC_API_KEY / OPENAI_API_KEY are
 * NOT copied — the subscription-CLI contract forbids metered API keys anyway,
 * so dropping them is both a security fix and a guard against silently switching
 * the CLI to paid billing.
 */

/** Non-secret vars the CLI genuinely needs (or benignly uses) to run. */
const ALLOWED_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  // The CLI binary overrides the vidi-chat service reads to locate the binaries.
  "CLAUDE_BIN",
  "CODEX_BIN",
  "GROK_BIN",
  // Node/npm operational (proxy is network config, not a secret; needed if the
  // CLI shells out to npm on a proxied network).
  "NODE_ENV",
  "npm_config_registry",
];

/**
 * Build the child's env: allowlisted parent vars + any explicit overrides.
 * `overrides` (e.g. { VIDI_AGENT_ID }) always wins and is copied verbatim, so a
 * caller can still inject the vars it controls. VIDI_* keys already present in
 * the parent env are also carried through (fleet-stamp inheritance) since they
 * are vidi's own non-secret coordination vars.
 */
export function scrubbedChildEnv(
  overrides: Record<string, string | undefined> = {},
  // Plain env-shaped record, not NodeJS.ProcessEnv: this function only ever
  // indexes/enumerates `parent`, so it doesn't need ProcessEnv's (Next.js-
  // augmented, NODE_ENV-required) shape — and typing it that way would force
  // every caller/fixture to satisfy that augmentation for no benefit.
  parent: Record<string, string | undefined> = process.env
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const v = parent[key];
    if (typeof v === "string") out[key] = v;
  }
  // vidi's own coordination vars (never secrets) pass through.
  for (const [key, v] of Object.entries(parent)) {
    if (key.startsWith("VIDI_") && typeof v === "string") out[key] = v;
  }
  for (const [key, v] of Object.entries(overrides)) {
    if (typeof v === "string") out[key] = v;
  }
  // The Next.js ProcessEnv augmentation marks NODE_ENV required; the spawn()
  // env option accepts a partial map at runtime, so widen through unknown.
  return out as unknown as NodeJS.ProcessEnv;
}
