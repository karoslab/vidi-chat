import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_ROOT } from "./workspace.ts";
import { dataDir } from "./data-dir.ts";
// dataDir is already imported above; isOwner reads data/onboarded.json + data/threads
// directly (not via lib/onboarding.ts) to avoid an import cycle.
import { DEFAULT_AGENT_NAME_STACK_ID, isNameStackId, NAME_STACKS } from "./agent-names.ts";
import { ASSISTANT_NAME } from "./assistant-identity.ts";

/**
 * Single source of truth for the per-user values that used to be hardcoded to
 * one person's setup (display name, brain dir name, the user-model filename,
 * and the machine paths to the gbrain / claude binaries and $HOME).
 *
 * This is the "de-hardcode" seam: any user runs the same app pointed at their
 * own name and brain without touching source. The built-in defaults are NEUTRAL
 * and machine-independent (a generic "the user", a generic Brain directory, and
 * binary/home paths derived from os.homedir()), so nothing owner-specific ships
 * in the public source. Each field resolves in this order (first wins):
 *
 *   1. an explicit environment variable (e.g. VIDI_USER_NAME) — the launchd
 *      plist sets these on the owner's install so their real name/brain/paths
 *      are restored without a source literal,
 *   2. the optional JSON file data/user-config.json (written by first-run
 *      onboarding; missing/corrupt file is fine — it just doesn't override),
 *   3. the built-in neutral default.
 *
 * The file is read ONCE and memoized — it is small, single-user config, and
 * re-reading it per call would be wasted syscalls.
 */

export interface UserConfig {
  /** How Vidi addresses the user in the UI and greetings. */
  displayName: string;
  /** Dir name (under the workspace root) that holds the gbrain brain. */
  brainDirName: string;
  /** Filename (under <brain>/wiki) of the nightly user model. */
  userModelFileName: string;
  /** Absolute path to the gbrain binary. */
  gbrainBin: string;
  /** Absolute path to the claude CLI binary (falls back to $PATH lookup). */
  claudeBin: string;
  /** The user's $HOME — the write-jail root and Desktop/Downloads base. */
  homeDir: string;
  /** Which curated stack (a NAME_STACKS id) the helpers Vidi deploys draw their
   *  default names from when no explicit name is given. Default = the Kannada /
   *  Indian-mythology stack (the hero set). An invalid stored value is ignored
   *  on read and falls back to the default. */
  agentNameStack: string;
  /** The persona name this install answers to. The BRAND stays "Vidi" (app
   *  title, launcher, docs — ASSISTANT_NAME); this is the per-install name the
   *  persona self-references, so a customer can call his assistant "Anna". The
   *  default is the brand name, so an install that never sets it is unchanged. */
  assistantName: string;
}

/** The current process user's home dir, resolved once. On the owner's machine
 *  this is their real $HOME, so the binary/home defaults below are byte-identical
 *  to the pre-scrub literals there; on anyone else's it is their own home. The
 *  owner's launchd plist can still pin VIDI_HOME_DIR / VIDI_GBRAIN_BIN /
 *  VIDI_CLAUDE_BIN explicitly if the layout differs. */
const HOME = os.homedir();

const DEFAULTS: UserConfig = {
  displayName: "the user",
  brainDirName: "Brain",
  userModelFileName: "user-model.md",
  gbrainBin: path.join(HOME, ".bun", "bin", "gbrain"),
  claudeBin: path.join(HOME, ".local", "bin", "claude"),
  homeDir: HOME,
  agentNameStack: DEFAULT_AGENT_NAME_STACK_ID,
  assistantName: ASSISTANT_NAME,
};

/**
 * The built-in NEUTRAL defaults, exposed read-only so the resolution-path test
 * suites can assert getUserConfig() returns exactly these values with no env and
 * no file WITHOUT restating any literal in test source. These no longer carry
 * any owner-specific value (that residue was retired); the owner's real name,
 * brain, and paths are injected at runtime through the env override seam
 * (VIDI_USER_NAME / VIDI_BRAIN_DIR / VIDI_GBRAIN_BIN / … — set by the launchd
 * plist).
 */
export const DEFAULT_USER_CONFIG: Readonly<UserConfig> = DEFAULTS;

/** Written by first-run onboarding. Under data/ (gitignored, per-install).
 *  Resolved at call time so VIDI_DATA_DIR (T1.6) and the tests' per-case chdir
 *  both point at the right file. */
const configFile = () => path.join(dataDir(), "user-config.json");

/**
 * Env var name for each field. An env var beats the JSON file so a launchd
 * plist / shell can force a value without editing data/.
 */
const ENV_KEYS: Record<keyof UserConfig, string> = {
  displayName: "VIDI_USER_NAME",
  brainDirName: "VIDI_BRAIN_DIR",
  userModelFileName: "VIDI_USER_MODEL_FILE",
  gbrainBin: "VIDI_GBRAIN_BIN",
  claudeBin: "VIDI_CLAUDE_BIN",
  homeDir: "VIDI_HOME_DIR",
  agentNameStack: "VIDI_AGENT_NAME_STACK",
  assistantName: "VIDI_ASSISTANT_NAME",
};

let cached: UserConfig | null = null;

function readJsonFileOverrides(): Partial<UserConfig> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    if (parsed && typeof parsed === "object") return parsed as Partial<UserConfig>;
  } catch {
    /* no file / corrupt — fall through to env + defaults */
  }
  return {};
}

/** Resolve one field: env var wins, then JSON file, then the built-in default. */
function resolveField(
  fieldName: keyof UserConfig,
  fileOverrides: Partial<UserConfig>
): string {
  const envValue = process.env[ENV_KEYS[fieldName]];
  if (typeof envValue === "string" && envValue.trim()) return envValue.trim();
  const fileValue = fileOverrides[fieldName];
  if (typeof fileValue === "string" && fileValue.trim()) return fileValue.trim();
  return DEFAULTS[fieldName];
}

export function getUserConfig(): UserConfig {
  if (cached) return cached;
  const fileOverrides = readJsonFileOverrides();
  // The built-in default identity is now NEUTRAL for everyone ("the user",
  // Brain), so no owner name can ever leak to an install that hasn't set its
  // own — the 2026-07-12 demo finding (the demo user greeted by the owner's
  // name) is structurally impossible. The owner restores their real name/brain
  // through the env/file override seam (VIDI_USER_NAME / VIDI_BRAIN_DIR).
  cached = {
    displayName: resolveField("displayName", fileOverrides),
    brainDirName: resolveField("brainDirName", fileOverrides),
    userModelFileName: resolveField("userModelFileName", fileOverrides),
    gbrainBin: resolveField("gbrainBin", fileOverrides),
    claudeBin: resolveField("claudeBin", fileOverrides),
    homeDir: resolveField("homeDir", fileOverrides),
    // Read-time defense: a stored agentNameStack that isn't a real stack id (a
    // hand-edited file, a stale value from a removed stack, an env typo) is
    // silently ignored and falls back to the default — never "no names to draw
    // from". The write path already rejects invalid ids loudly (400).
    agentNameStack: resolveAgentNameStack(fileOverrides),
    assistantName: resolveField("assistantName", fileOverrides),
  };
  return cached;
}

/**
 * The persona name this install answers to (default "Vidi" — the brand). Read
 * through the memoized config, which the settings write path invalidates, so a
 * just-set name takes effect without a restart. The BRAND (app title, launcher,
 * docs) stays ASSISTANT_NAME regardless; this is only the persona self-name.
 */
export function getAssistantName(): string {
  return getUserConfig().assistantName;
}

/** Resolve the agentNameStack preference with a silent fallback: env wins, then
 *  file, then default — but any value that isn't a real stack id is dropped and
 *  the default returned. */
function resolveAgentNameStack(fileOverrides: Partial<UserConfig>): string {
  const raw = resolveField("agentNameStack", fileOverrides);
  return isNameStackId(raw) ? raw : DEFAULTS.agentNameStack;
}

/** Test-only: drop the memoized config so a test can change env/file and re-read. */
export function _resetUserConfigCache(): void {
  cached = null;
}

/** The stack id the fleet should draw default helper names from — already
 *  sanitized (an invalid stored value yields the default). Read live (not the
 *  memoized config) so a just-written preference takes effect without a
 *  restart, matching the guarded write path. */
export function getPreferredAgentNameStackId(): string {
  return resolveAgentNameStack(readJsonFileOverrides());
}

/**
 * The subset of fields the settings panel (T1.3) lets a user view/edit. The
 * machine-path fields (gbrainBin/claudeBin/userModelFileName) stay
 * env/file-only — they're advanced setup a non-technical second user should
 * never see in a friendly panel.
 *
 * homeDir is deliberately NOT here (F5, defense-in-depth): it feeds the CLI
 * write-jail roots, so the HTTP route must never be able to write it. It's still
 * READ (getUserConfig resolves it from env/file/default) — the env var and a
 * hand-edited data/user-config.json remain the power-user paths.
 */
export const EDITABLE_CONFIG_FIELDS = [
  "displayName",
  "brainDirName",
  "agentNameStack",
  "assistantName",
] as const;
export type EditableConfigField = (typeof EDITABLE_CONFIG_FIELDS)[number];

/**
 * agentNameStack must be the id of one of the curated NAME_STACKS — the helpers
 * Vidi deploys draw their default names from it. Anything else is rejected on
 * write with a plain-language reason (the onboarding step / Canvas picker only
 * ever send a real id, so this guards a malformed request, not normal use).
 * Returns null when valid, else the reason. Kept separate so both the write gate
 * and its tests can call it directly.
 */
export function validateAgentNameStack(raw: string): string | null {
  if (isNameStackId(raw.trim())) return null;
  const validIds = NAME_STACKS.map((stack) => stack.id).join(", ");
  return `That isn't a name set I recognize. Pick one of: ${validIds}.`;
}

/** Longest display name the write path stores — matches onboarding's cap. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

/**
 * displayName is interpolated into LLM prompt strings (session preamble, voice
 * system text, fleet briefs), so a stored value carrying newlines or other
 * control characters could forge extra prompt lines. Strip control chars
 * (0x00-0x1F incl. \n/\r/\t, and 0x7F), collapse whitespace runs, and trim —
 * a benign name passes through unchanged.
 */
export function sanitizeDisplayName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate a displayName AFTER sanitization: only a length cap — an empty
 * value stays legal (it means "clear back to the default"). Returns null when
 * valid, else a plain-language reason the SettingsPanel surfaces verbatim.
 */
export function validateDisplayName(raw: string): string | null {
  if (sanitizeDisplayName(raw).length > DISPLAY_NAME_MAX_LENGTH) {
    return `That name is too long — keep it under ${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * brainDirName is joined under WORKSPACE_ROOT to form the brain root, so it must
 * be a SINGLE plain path segment — never a traversal ("../../etc"), an absolute
 * path ("/etc"), "."/".." , or anything containing a path separator (incl. the
 * platform-specific one). Returns null when valid, else a plain-language reason
 * the SettingsPanel surfaces verbatim. Kept separate from the write path so both
 * the write-time gate and its tests can call it directly.
 */
export function validateBrainDirName(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Your memory folder name can't be empty.";
  if (value === "." || value === "..") return "Your memory folder name can't be “.” or “..”.";
  if (value.includes("/") || value.includes("\\") || value.includes(path.sep)) {
    return "Your memory folder name must be a single folder — no slashes or path separators.";
  }
  // A single segment must survive path.basename unchanged (catches null bytes,
  // drive prefixes, and anything else that would relocate the join target).
  if (path.basename(value) !== value) {
    return "Your memory folder name must be a single, plain folder name.";
  }
  return null;
}

export interface ConfigFieldSource {
  /** The currently resolved value (what the app is using). */
  value: string;
  /** True when an environment variable is forcing this value — the file cannot
   *  override it, so the panel shows a "set by environment" badge and locks it. */
  envLocked: boolean;
}

/**
 * Report, per editable field, the resolved value and whether an env var is
 * locking it. Powers the settings panel's badges. Reads live (not the memoized
 * config) so a just-written file is reflected without a restart.
 */
export function getEditableConfigWithSources(): Record<EditableConfigField, ConfigFieldSource> {
  const fileOverrides = readJsonFileOverrides();
  const out = {} as Record<EditableConfigField, ConfigFieldSource>;
  for (const fieldName of EDITABLE_CONFIG_FIELDS) {
    const envValue = process.env[ENV_KEYS[fieldName]];
    const envLocked = typeof envValue === "string" && envValue.trim().length > 0;
    // agentNameStack reports its SANITIZED value (a garbage stored id shows the
    // default), so the picker/settings highlight a real stack; the other fields
    // report the raw resolved value.
    out[fieldName] = {
      value:
        fieldName === "agentNameStack"
          ? resolveAgentNameStack(fileOverrides)
          : resolveField(fieldName, fileOverrides),
      envLocked,
    };
  }
  return out;
}

/**
 * Merge the given editable-field overrides into data/user-config.json and drop
 * the memoized config so the change takes effect without a restart. ONLY the
 * editable fields are accepted (unknown keys are ignored); an env-locked field
 * is skipped because the env var wins anyway and writing it would be a
 * misleading no-op. Existing keys in the file (e.g. brain overrides written by
 * onboarding) are preserved. Returns the fresh sources so the caller can echo
 * the new state back to the UI. Throws only on an unwritable file — the route
 * turns that into a plain-language error.
 */
/** Thrown by writeEditableConfig when an incoming value fails validation. Its
 *  message is plain-language and safe to show the user verbatim (the route maps
 *  it to a 400; an unwritable-file error stays a generic 500). */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function writeEditableConfig(
  overrides: Partial<Record<EditableConfigField, string>>
): Record<EditableConfigField, ConfigFieldSource> {
  // Validate BEFORE touching disk so a bad brainDirName (traversal / absolute /
  // "."/"..") is rejected with a plain-language message and nothing is written.
  // Skip validation of an env-locked field: it isn't stored anyway (below).
  const brainIncoming = overrides.brainDirName;
  const brainEnvLocked =
    typeof process.env[ENV_KEYS.brainDirName] === "string" &&
    !!process.env[ENV_KEYS.brainDirName]!.trim();
  if (typeof brainIncoming === "string" && brainIncoming.trim() && !brainEnvLocked) {
    const reason = validateBrainDirName(brainIncoming);
    if (reason) throw new ConfigValidationError(reason);
  }

  // displayName: sanitize (strip control chars/newlines — it feeds LLM prompt
  // strings) and reject an over-long value before disk. The SANITIZED value is
  // what gets stored (below). An env-locked value isn't written anyway.
  const nameIncoming = overrides.displayName;
  const nameEnvLocked =
    typeof process.env[ENV_KEYS.displayName] === "string" &&
    !!process.env[ENV_KEYS.displayName]!.trim();
  if (typeof nameIncoming === "string" && !nameEnvLocked) {
    const reason = validateDisplayName(nameIncoming);
    if (reason) throw new ConfigValidationError(reason);
    overrides = { ...overrides, displayName: sanitizeDisplayName(nameIncoming) };
  }

  // assistantName feeds the persona self-name block in the system prompt
  // (lib/chat-system-text.ts), so it gets the exact same treatment as
  // displayName: strip control chars/newlines, cap the length, and store the
  // SANITIZED value. An env-locked value isn't written anyway.
  const assistantNameIncoming = overrides.assistantName;
  const assistantNameEnvLocked =
    typeof process.env[ENV_KEYS.assistantName] === "string" &&
    !!process.env[ENV_KEYS.assistantName]!.trim();
  if (typeof assistantNameIncoming === "string" && !assistantNameEnvLocked) {
    const reason = validateDisplayName(assistantNameIncoming);
    if (reason) throw new ConfigValidationError(reason);
    overrides = { ...overrides, assistantName: sanitizeDisplayName(assistantNameIncoming) };
  }

  // Same loud-reject-before-disk gate for agentNameStack: only a real stack id
  // may be stored. An env-locked value isn't written anyway (skipped below), so
  // don't reject it here.
  const stackIncoming = overrides.agentNameStack;
  const stackEnvLocked =
    typeof process.env[ENV_KEYS.agentNameStack] === "string" &&
    !!process.env[ENV_KEYS.agentNameStack]!.trim();
  if (typeof stackIncoming === "string" && stackIncoming.trim() && !stackEnvLocked) {
    const reason = validateAgentNameStack(stackIncoming);
    if (reason) throw new ConfigValidationError(reason);
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    /* first write / corrupt — start from empty and overwrite */
  }
  if (!existing || typeof existing !== "object") existing = {};

  const next: Record<string, unknown> = { ...existing };
  for (const fieldName of EDITABLE_CONFIG_FIELDS) {
    const incoming = overrides[fieldName];
    if (typeof incoming !== "string") continue;
    // An env var already forces this field — writing the file wouldn't change
    // the resolved value, so skip it rather than store a misleading override.
    if (typeof process.env[ENV_KEYS[fieldName]] === "string" && process.env[ENV_KEYS[fieldName]]!.trim()) {
      continue;
    }
    const trimmed = incoming.trim();
    if (trimmed) next[fieldName] = trimmed;
    else delete next[fieldName]; // clearing a field falls back to the default
  }

  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  _resetUserConfigCache(); // the change takes effect without a restart
  return getEditableConfigWithSources();
}

/**
 * Absolute path to the brain (gbrain) root under the workspace.
 *
 * Read-time defense-in-depth: even though writeEditableConfig now validates
 * brainDirName, a value can still arrive via an env var or a hand-edited
 * data/user-config.json. So after joining we path.resolve and require the result
 * to be STRICTLY under WORKSPACE_ROOT; anything that escapes (e.g. "../../etc"
 * resolving to /etc) falls back to the built-in default brain dir and logs, so a
 * bad config can never point the brain at an arbitrary filesystem location.
 */
export function brainRoot(): string {
  const dirName = getUserConfig().brainDirName;
  const resolved = path.resolve(WORKSPACE_ROOT, dirName);
  const base = path.resolve(WORKSPACE_ROOT);
  if (resolved === base || resolved.startsWith(base + path.sep)) {
    return resolved;
  }
  console.error(
    `[user-config] brainDirName ${JSON.stringify(dirName)} escapes the workspace root; ` +
      `falling back to the default brain dir ${JSON.stringify(DEFAULTS.brainDirName)}.`
  );
  return path.resolve(WORKSPACE_ROOT, DEFAULTS.brainDirName);
}

/** Build an absolute path under the brain root from path segments. */
export function brainPath(...segments: string[]): string {
  return path.join(brainRoot(), ...segments);
}

/* -------------------------------------------------------------------------- */
/* Owner signal (Phase 4a hardening)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Is this the OWNER's install, as opposed to a second, non-technical user who
 * onboarded on a fresh install?
 *
 * The owner gets Auto-capable defaults and the full outward-facing egress
 * (TTS, phone push); a NON-owner install defaults to Plan mode and makes ZERO
 * external network calls, so the security notice's "nothing else leaves your
 * computer" is literally true for them. Auto and egress are still reachable,
 * but only by an explicit opt-in — never as the default.
 *
 * Resolution (first that decides wins):
 *   1. env VIDI_OWNER — "1"/"true"/"yes" forces owner; "0"/"false"/"no" forces
 *      non-owner. This is the explicit override for either party.
 *   2. the onboarded flag's provenance: an install that was marked onboarded via
 *      the boot-time backfill ("existing-install" — i.e. it already had threads
 *      before onboarding shipped, which is the owner) is the OWNER. An install
 *      marked onboarded through the first-run FLOW ("flow") is a fresh, second
 *      user → NON-owner.
 *   3. no flag yet: if the install already has saved threads it's a pre-existing
 *      (owner) install the backfill just hasn't stamped; a truly fresh install
 *      with no threads is treated as NON-owner (safe default — Plan-mode,
 *      no egress — until it proves otherwise). This mirrors onboarding.ts's
 *      "existing data = already using Vidi" rule.
 *
 * Read live (not memoized) and fully fail-open: any error resolves to the SAFE
 * answer (non-owner), because over-restricting the owner is a mild annoyance
 * while under-restricting a second user is the whole thing we're guarding.
 *
 * Deliberately reads data/ files directly (not via lib/onboarding.ts) to avoid
 * an import cycle — onboarding.ts already imports from this module.
 */
export function isOwner(): boolean {
  // F1 (Phase 4a re-review): VIDI_OWNER is the AUTHORITATIVE, durable owner
  // signal and is checked first — set VIDI_OWNER=1 in the owner's launchd
  // plist so ownership never rests on a jail-adjacent file. The file-based inference
  // below is only a FALLBACK for when VIDI_OWNER is unset, and both files it
  // reads (onboarded.json, data/threads/*.json) are now on the SECRET_PATHS
  // denylist (lib/providers/claude.ts) so neither the agent's Write/Edit tools
  // nor the write-file confirm executor can forge them to flip ownership.
  const envRaw = process.env.VIDI_OWNER;
  if (typeof envRaw === "string" && envRaw.trim()) {
    const v = envRaw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes") return true;
    if (v === "0" || v === "false" || v === "no") return false;
    // Any other non-empty value is treated as a truthy owner override.
    return true;
  }

  // The onboarded flag records HOW the install became onboarded (see
  // onboarding.ts markOnboarded): "existing-install" = backfilled owner,
  // "flow" = a fresh second user finished onboarding.
  try {
    const flag = JSON.parse(
      fs.readFileSync(path.join(dataDir(), "onboarded.json"), "utf8")
    );
    if (flag && typeof flag === "object" && typeof flag.source === "string") {
      return flag.source === "existing-install";
    }
  } catch {
    /* no flag yet — fall through to the threads heuristic */
  }

  // No flag: a pre-existing install (has saved threads) is the owner the boot
  // backfill just hasn't stamped yet; a truly fresh install is non-owner.
  try {
    return fs
      .readdirSync(path.join(dataDir(), "threads"))
      .some((f) => f.endsWith(".json"));
  } catch {
    return false; // no threads dir → fresh install → non-owner (safe default)
  }
}

/**
 * Is Auto (act) mode permitted on this install? (Phase 4a — P5.)
 *
 * The OWNER always has act mode. A NON-owner gets it ONLY when the owner has
 * explicitly opted them in — never through their own in-app Plan/Auto toggle.
 * That opt-in is the owner-set env VIDI_ACT_OPT_IN ("1"/"true"/"yes"), the
 * same trust class as VIDI_OWNER (a launchd-plist value they can't flip from
 * inside the app). Without it, the provider clamps every "auto" request to
 * Plan, so "Vidi suggests; it doesn't act on your behalf yet" is enforced, not
 * just copy. Read live (env + isOwner) and fail-safe: any ambiguity → not
 * allowed.
 *
 * NOTE: this gates whether the ACTING surface is reachable at all; the DEFAULT
 * mode (owner → auto, non-owner → plan) is decided separately at thread creation
 * (voice-turn.ts). A non-owner install without the opt-in can't act even if the
 * default or the toggle says "auto".
 */
export function actModeAllowed(): boolean {
  if (isOwner()) return true;
  const raw = process.env.VIDI_ACT_OPT_IN;
  if (typeof raw === "string" && raw.trim()) {
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  // In-app Builder toggle (2026-07-12): same consent, same rails as the Vidi
  // Helper menu toggle, persisted per-install. Read live, fail-closed — a
  // missing or corrupt file means Plan only. The env key above still wins
  // (a plist-set 0/1 is authoritative for managed installs).
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), "builder-mode.json"), "utf8"));
    return parsed?.on === true;
  } catch {
    return false;
  }
}

/** Persist the in-app Builder opt-in (the guarded route is the only writer). */
export function setBuilderMode(on: boolean): void {
  const file = path.join(dataDir(), "builder-mode.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ on: on === true, at: new Date().toISOString() }));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* permissions are best-effort on exotic filesystems */
  }
}
