import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import { secureDataFile } from "./data-dir.ts";
import {
  validateVoiceId,
  validateVoiceKey,
  type VoiceConfig,
  type VoiceTier,
} from "./voice-catalog.ts";

// Re-export the client-safe catalog pieces so existing server-side importers
// (and tests) can keep importing them from lib/voice-tier.ts.
export {
  INSTALL_VOICE_KEY_PREFIX,
  PREMIUM_VOICE_CATALOG,
  pickBestSystemVoice,
  validateVoiceId,
  validateVoiceKey,
  type LocalVoiceOption,
  type PremiumVoiceCatalogEntry,
  type VoiceConfig,
  type VoiceTier,
} from "./voice-catalog.ts";

/**
 * Three-tier voice for Vidi (2026-07-11 external-customer push).
 *
 *   - system  : the browser's own speechSynthesis voice. Zero config, zero
 *               egress, works on EVERY install including a non-owner one. This is
 *               the DEFAULT for a fresh install.
 *   - premium : synthesized through the owner's vidi-proxy worker. The OWNER uses
 *               the shared proxy secret (unchanged). A CUSTOMER uses a per-install
 *               "voice code" (an A2 keyset key) they paste in, AND must accept an
 *               explicit voice-egress consent first. Customers never get their own
 *               xAI / ElevenLabs API keys — only a metered, revocable voice code.
 *
 * This module owns the per-install voice state (all under data/, gitignored,
 * per-install) and the pure premium-eligibility decision. The stored voice code
 * is a secret: written 0600 and added to the SECRET_PATHS denylist
 * (lib/providers/claude.ts) exactly like the phone/control tokens, so the agent
 * can never Read/Edit/Write it to forge a raw worker call.
 */

/* -------------------------------------------------------------------------- */
/* On-disk locations (per-install, under data/)                               */
/* -------------------------------------------------------------------------- */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) so tests can chdir/point at a temp dir per case.
const voiceKeyFile = () => dataPath("voice-key");
const voiceConsentFile = () => dataPath("voice-consent.json");
const voiceConfigFile = () => dataPath("voice-config.json");

/* -------------------------------------------------------------------------- */
/* Validation error (plain-language, safe to show verbatim)                   */
/* -------------------------------------------------------------------------- */

/** Thrown by the write paths when an incoming value fails validation. Its
 *  message is plain-language and safe to show the user verbatim (routes map it
 *  to a 400). */
export class VoiceConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigValidationError";
  }
}

/* -------------------------------------------------------------------------- */
/* Voice code (the pasted per-install key)                                    */
/* -------------------------------------------------------------------------- */

/** The stored voice code, or null when none is stored / unreadable. */
export function readVoiceKey(): string | null {
  try {
    const existing = fs.readFileSync(voiceKeyFile(), "utf8").trim();
    return existing || null;
  } catch {
    return null;
  }
}

/** True when a voice code is stored on this install. */
export function hasVoiceKey(): boolean {
  return readVoiceKey() !== null;
}

/**
 * Store (or clear) the pasted voice code. A non-empty value is validated first
 * (throws VoiceConfigValidationError on a bad paste), then written 0600 and
 * secured via secureDataFile (same 0600 + 0700 data/ treatment as the phone
 * token). An empty/whitespace value clears the stored code.
 */
export function storeVoiceKey(raw: string): void {
  const value = raw.trim();
  if (!value) {
    try {
      fs.rmSync(voiceKeyFile());
    } catch {
      /* nothing stored — clearing is a no-op */
    }
    return;
  }
  const reason = validateVoiceKey(value);
  if (reason) throw new VoiceConfigValidationError(reason);
  fs.mkdirSync(path.dirname(voiceKeyFile()), { recursive: true });
  fs.writeFileSync(voiceKeyFile(), value + "\n", { mode: 0o600 });
  secureDataFile(voiceKeyFile()); // 0600 file + 0700 data/, best-effort
}

/* -------------------------------------------------------------------------- */
/* Voice-egress consent                                                       */
/* -------------------------------------------------------------------------- */

/** True when the explicit voice-egress consent has been accepted on this
 *  install. Fail-closed: any read/parse error means "not consented". */
export function hasVoiceEgressConsent(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(voiceConsentFile(), "utf8"));
    return !!(parsed && typeof parsed === "object" && parsed.accepted === true);
  } catch {
    return false;
  }
}

/** Record (or withdraw) voice-egress consent. */
export function setVoiceEgressConsent(accepted: boolean): void {
  fs.mkdirSync(path.dirname(voiceConsentFile()), { recursive: true });
  fs.writeFileSync(
    voiceConsentFile(),
    JSON.stringify({ accepted: !!accepted, at: new Date().toISOString() }, null, 2)
  );
  secureDataFile(voiceConsentFile());
}

/* -------------------------------------------------------------------------- */
/* Voice config (tier + selected voices)                                      */
/* -------------------------------------------------------------------------- */

/** The stored voice config, defaulting to the system tier. Fail-open: any
 *  read/parse error yields the safe default (system voice, no egress). */
export function readVoiceConfig(): VoiceConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(voiceConfigFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const tier: VoiceTier = parsed.tier === "premium" ? "premium" : "system";
      const config: VoiceConfig = { tier };
      if (typeof parsed.systemVoice === "string" && parsed.systemVoice.trim()) {
        config.systemVoice = parsed.systemVoice.trim();
      }
      if (typeof parsed.premiumVoiceId === "string" && parsed.premiumVoiceId.trim()) {
        config.premiumVoiceId = parsed.premiumVoiceId.trim();
      }
      return config;
    }
  } catch {
    /* no file / corrupt — safe default */
  }
  return { tier: "system" };
}

/** A browser voice name feeds a client-side API only (never a prompt), but keep
 *  it a single clean line and length-capped anyway. */
function sanitizeVoiceName(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Merge voice-config overrides. Validates tier and premiumVoiceId (loud reject
 * before disk), sanitizes the system voice name, preserves unset fields, and
 * returns the fresh config. Throws VoiceConfigValidationError on a bad value.
 */
export function writeVoiceConfig(overrides: Partial<VoiceConfig>): VoiceConfig {
  if (overrides.tier !== undefined && overrides.tier !== "system" && overrides.tier !== "premium") {
    throw new VoiceConfigValidationError("Voice tier must be system or premium.");
  }
  if (typeof overrides.premiumVoiceId === "string" && overrides.premiumVoiceId.trim()) {
    const reason = validateVoiceId(overrides.premiumVoiceId);
    if (reason) throw new VoiceConfigValidationError(reason);
  }

  const existing = readVoiceConfig();
  const next: VoiceConfig = { ...existing };
  if (overrides.tier !== undefined) next.tier = overrides.tier;
  if (overrides.systemVoice !== undefined) {
    const cleaned = sanitizeVoiceName(overrides.systemVoice);
    if (cleaned) next.systemVoice = cleaned;
    else delete next.systemVoice;
  }
  if (overrides.premiumVoiceId !== undefined) {
    const trimmed = overrides.premiumVoiceId.trim();
    if (trimmed) next.premiumVoiceId = trimmed;
    else delete next.premiumVoiceId;
  }

  fs.mkdirSync(path.dirname(voiceConfigFile()), { recursive: true });
  fs.writeFileSync(voiceConfigFile(), JSON.stringify(next, null, 2));
  secureDataFile(voiceConfigFile());
  return next;
}

/* -------------------------------------------------------------------------- */
/* Premium-eligibility decision (pure — the security gate)                    */
/* -------------------------------------------------------------------------- */

export interface PremiumTtsInputs {
  /** isOwner() for this install. */
  owner: boolean;
  /** Whether a voice code is stored. */
  hasVoiceKey: boolean;
  /** Whether voice-egress consent was accepted. */
  hasConsent: boolean;
}

export interface PremiumTtsDecision {
  /** True when premium synthesis (worker egress) is allowed. */
  allowed: boolean;
  /** HTTP status the route should return when NOT allowed (a plain 4xx). 200
   *  when allowed. */
  status: number;
  /** Plain-language reason to show the user when NOT allowed. */
  message?: string;
}

/**
 * The single premium-TTS gate. Pure so the whole matrix is unit-tested:
 *
 *   - OWNER                       → allowed (uses the shared proxy secret).
 *   - non-owner + key + consent   → allowed (uses the pasted voice code).
 *   - non-owner missing the key   → 403, "add your voice code".
 *   - non-owner has key, no consent → 403, "accept voice egress".
 *
 * A non-owner without BOTH is told about the missing code first (there is
 * nothing to consent to yet). When not allowed the route still returns the
 * X-Vidi-Local-Only signal so the client falls back to the system voice.
 */
export function evaluatePremiumTts(inputs: PremiumTtsInputs): PremiumTtsDecision {
  if (inputs.owner) return { allowed: true, status: 200 };
  if (!inputs.hasVoiceKey) {
    return {
      allowed: false,
      status: 403,
      message:
        "Premium voice needs a voice code. Paste the code you were given in Settings to turn it on.",
    };
  }
  if (!inputs.hasConsent) {
    return {
      allowed: false,
      status: 403,
      message:
        "Premium voice needs your okay to send spoken replies to the voice service. Turn it on in Settings.",
    };
  }
  return { allowed: true, status: 200 };
}
