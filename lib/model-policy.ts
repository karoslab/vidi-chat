import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./data-dir.ts";
import { DEEP_DEFAULT_EFFORT, normalizeEffort, type Effort } from "./models.ts";

/**
 * Token-discipline model policy (the owner's rule — the DEFAULT for every install).
 *
 * Two tiers, so the setup never burns the top model on cheap work:
 *   - DEEP tier: deliberate planning / build-shaped / review work. Claude → opus
 *     at "high" effort. This is what the AUTO router (lib/models.ts) already
 *     picks for plan mode / high+ effort; a build-shaped delegation is pinned to
 *     it explicitly (deepModel="auto" so the router resolves opus, deepEffort
 *     "high"). Fable is retired — nothing here ever routes to it.
 *   - WORKER tier: every spawned fleet/background agent that ISN'T flagged
 *     build-shaped. Claude → sonnet, codex → the cheapest gpt slug, at "medium"
 *     effort. This is the fleet-wide fallback in lib/agents/manager.ts spawn().
 *
 * Provider-aware: an install with ONLY the claude CLI (the first external
 * customer) is fully served by the claude fields alone — the codex field is only
 * consulted when a codex worker is actually spawned. Grok is not fleet-spawnable
 * (manager.spawn only makes claude/codex agents), so it carries no worker knob.
 *
 * Per-install overridable, but the SHIPPED default IS the policy below. Overrides
 * resolve env > data/user-config.json (`modelPolicy` key) > built-in default —
 * the same precedence and the same "read-time defense" invariant as
 * lib/user-config.ts: any stored/env value that isn't a value we recognize is
 * silently dropped and the default returned, so a hand-edited or stale config can
 * never leave a spawn with "no model". A fresh non-owner install (no env, no
 * file) gets the policy out of the box.
 */
export interface ModelPolicy {
  /** Claude model for a build-shaped / deep delegation. "auto" lets the router
   *  resolve opus (provider-aware); an explicit "opus" pins it directly. */
  deepModel: string;
  /** Effort for a deep/build-shaped turn. Defaults to the router's deep default
   *  ("high"). */
  deepEffort: Effort;
  /** Claude model every un-flagged spawned worker/fleet agent runs on. */
  workerModelClaude: string;
  /** Codex model an un-flagged spawned codex worker runs on — the cheapest slug
   *  in the catalog by default (gpt-5.5). "default" defers to ~/.codex/config.toml. */
  workerModelCodex: string;
  /** Effort every un-flagged spawned worker runs at. */
  workerEffort: Effort;
}

/** The shipped default — the token-discipline policy itself. */
export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  deepModel: "auto",
  deepEffort: DEEP_DEFAULT_EFFORT, // "high"
  workerModelClaude: "sonnet",
  workerModelCodex: "gpt-5.5",
  workerEffort: "medium",
};

/** Env var per overridable field (env beats the JSON file beats the default). */
const ENV_KEYS: Record<keyof ModelPolicy, string> = {
  deepModel: "VIDI_DEEP_MODEL",
  deepEffort: "VIDI_DEEP_EFFORT",
  workerModelClaude: "VIDI_WORKER_MODEL",
  workerModelCodex: "VIDI_WORKER_CODEX_MODEL",
  workerEffort: "VIDI_WORKER_EFFORT",
};

// Small local allowlists so this module stays dependency-light (importing the
// provider chain to validate would pull the whole CLI adapter and risk an import
// cycle — manager.ts imports this module). Kept in sync with the provider
// catalogs (lib/providers/{claude,codex}.ts) by hand; an unknown value is
// dropped on read, never fatal.
const CLAUDE_WORKER_MODELS = new Set(["auto", "opus", "sonnet"]);
const CODEX_WORKER_MODELS = new Set([
  "default",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);

const configFile = () => path.join(dataDir(), "user-config.json");

/** Read the optional `modelPolicy` object from data/user-config.json. Missing /
 *  corrupt / wrong-shaped file → {} (fall through to env + defaults). */
function readFileOverrides(): Partial<Record<keyof ModelPolicy, unknown>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    const mp = parsed?.modelPolicy;
    if (mp && typeof mp === "object") return mp as Partial<Record<keyof ModelPolicy, unknown>>;
  } catch {
    /* no file / corrupt — env + defaults still apply */
  }
  return {};
}

/** Env value for a field, trimmed, or undefined when unset/blank. */
function envValue(field: keyof ModelPolicy): string | undefined {
  const raw = process.env[ENV_KEYS[field]];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** Resolve one string field against an allowlist: env > file > default, and any
 *  value not in `allowed` is silently dropped (read-time defense). */
function resolveModel(
  field: keyof ModelPolicy,
  allowed: ReadonlySet<string>,
  fileOverrides: Partial<Record<keyof ModelPolicy, unknown>>
): string {
  const env = envValue(field);
  if (env && allowed.has(env)) return env;
  const file = fileOverrides[field];
  if (typeof file === "string" && allowed.has(file.trim())) return file.trim();
  return DEFAULT_MODEL_POLICY[field] as string;
}

/** Resolve an effort field: env > file > default, via the ladder-validating
 *  normalizeEffort — but an ABSENT/invalid value must fall back to THIS field's
 *  policy default (not normalizeEffort's blanket "medium"), so deepEffort stays
 *  "high" unless explicitly overridden to a real level. */
function resolveEffort(
  field: "deepEffort" | "workerEffort",
  fileOverrides: Partial<Record<keyof ModelPolicy, unknown>>
): Effort {
  const fallback = DEFAULT_MODEL_POLICY[field];
  const env = envValue(field);
  if (env) {
    const e = normalizeEffort(env);
    // normalizeEffort returns "medium" for junk; only trust it when the raw
    // string really was a ladder level, else fall through to file/default.
    if (isLadderLevel(env)) return e;
  }
  const file = fileOverrides[field];
  if (typeof file === "string" && isLadderLevel(file.trim())) return normalizeEffort(file.trim());
  return fallback;
}

function isLadderLevel(v: string): v is Effort {
  return ["low", "medium", "high", "xhigh", "max", "ultra"].includes(v);
}

/**
 * The resolved, sanitized policy for this install. Read live (not memoized) so a
 * just-written override (or a per-test VIDI_DATA_DIR / env change) takes effect
 * without a restart — the same live-read discipline as
 * getPreferredAgentNameStackId() in lib/user-config.ts. Cheap: a couple of env
 * reads plus one small JSON parse per spawn.
 */
export function getModelPolicy(): ModelPolicy {
  const fileOverrides = readFileOverrides();
  return {
    deepModel: resolveModel("deepModel", CLAUDE_WORKER_MODELS, fileOverrides),
    deepEffort: resolveEffort("deepEffort", fileOverrides),
    workerModelClaude: resolveModel("workerModelClaude", CLAUDE_WORKER_MODELS, fileOverrides),
    workerModelCodex: resolveModel("workerModelCodex", CODEX_WORKER_MODELS, fileOverrides),
    workerEffort: resolveEffort("workerEffort", fileOverrides),
  };
}

/** The default WORKER model for a spawned agent of `provider`, per policy. Any
 *  provider that isn't fleet-spawnable (only claude/codex are) falls back to the
 *  claude worker model — a harmless default the manager never actually uses. */
export function workerModelFor(provider: string): string {
  const policy = getModelPolicy();
  return provider === "codex" ? policy.workerModelCodex : policy.workerModelClaude;
}

/** The default WORKER effort for a spawned agent, per policy. */
export function workerEffort(): Effort {
  return getModelPolicy().workerEffort;
}
