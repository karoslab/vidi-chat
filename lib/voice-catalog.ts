/**
 * Client-safe voice-tier types, catalog, and pure validators/pickers (no
 * node:fs) so both the browser components (VoiceSettings, Chat) and the
 * server-only lib/voice-tier.ts can share exactly one definition. The fs-backed
 * storage + the premium-eligibility gate live in lib/voice-tier.ts.
 */

export type VoiceTier = "system" | "premium";

export interface VoiceConfig {
  /** Which tier this install speaks with. Default "system". */
  tier: VoiceTier;
  /** The chosen browser speechSynthesis voice NAME for the system tier. Optional
   *  — when unset the client picks the best local en-US voice itself. */
  systemVoice?: string;
  /** The premium voice id sent to the worker (a grok voice id from the catalog,
   *  or an ElevenLabs voice id passthrough). Optional — unset means the worker's
   *  configured default voice. */
  premiumVoiceId?: string;
}

export interface PremiumVoiceCatalogEntry {
  /** The voice id sent to the worker as the `voiceId` param. */
  id: string;
  /** Plain-language label for the picker. */
  label: string;
  /** Which upstream the worker routes this id to. */
  provider: "grok" | "elevenlabs";
}

/**
 * The static premium-voice catalog. Used when the worker does not (yet) expose a
 * voice list of its own. The grok voices are the ones the worker's Grok TTS path
 * accepts (GROK_VOICE_ID; "ara" is the default the live Mac app uses). ElevenLabs
 * voices (including future consented voice clones) are added as `elevenlabs`
 * entries by their voice id, or passed through per-install via premiumVoiceId.
 */
export const PREMIUM_VOICE_CATALOG: readonly PremiumVoiceCatalogEntry[] = [
  { id: "ara", label: "Ara (default)", provider: "grok" },
  { id: "eve", label: "Eve", provider: "grok" },
  { id: "rex", label: "Rex", provider: "grok" },
  { id: "sal", label: "Sal", provider: "grok" },
  { id: "leo", label: "Leo", provider: "grok" },
];

/** The install-key prefix the worker mints (keyset.ts INSTALL_KEY_PREFIX). A
 *  pasted voice code must start with this to be a plausible per-install key. */
export const INSTALL_VOICE_KEY_PREFIX = "vidi_live_";

/**
 * Validate a pasted voice code BEFORE storing. It must look like a per-install
 * keyset key: the `vidi_live_` prefix followed by hex. Returns null when valid,
 * else a plain-language reason. Deliberately does NOT verify it against the
 * worker here (a revoked/typo key simply 401s at synthesis time and the client
 * falls back to the system voice) — this only rejects an obviously-wrong paste.
 */
export function validateVoiceKey(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Paste the voice code you were given to turn on premium voice.";
  if (!value.startsWith(INSTALL_VOICE_KEY_PREFIX)) {
    return "That does not look like a voice code. It should start with vidi_live_.";
  }
  const body = value.slice(INSTALL_VOICE_KEY_PREFIX.length);
  if (!/^[0-9a-fA-F]{16,64}$/.test(body)) {
    return "That voice code looks incomplete. Paste the whole code you were given.";
  }
  return null;
}

/**
 * A premiumVoiceId is valid when it is a known catalog id OR an ElevenLabs-style
 * id (alphanumeric passthrough — ElevenLabs voice ids are ~20-char base62). This
 * keeps a customer's selection to real voices, not an arbitrary string, while
 * still allowing a future consented clone's ElevenLabs voiceId to pass through.
 * Returns null when valid, else a plain-language reason.
 */
export function validateVoiceId(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Pick a premium voice.";
  if (PREMIUM_VOICE_CATALOG.some((entry) => entry.id === value)) return null;
  if (/^[A-Za-z0-9]{16,40}$/.test(value)) return null; // ElevenLabs voice id passthrough
  return "That is not a voice I recognize. Pick one from the list.";
}

export interface LocalVoiceOption {
  name: string;
  lang?: string;
}

/**
 * Pick the best local speechSynthesis voice: the user's stored choice if it is
 * still installed, else a high-quality en-US voice (Samantha on macOS), else any
 * en-US, else any English, else the first available. Pure so it is unit-tested;
 * the client passes speechSynthesis.getVoices() mapped to {name, lang}.
 */
export function pickBestSystemVoice(
  voices: readonly LocalVoiceOption[],
  preferredName?: string
): string | null {
  if (voices.length === 0) return null;
  if (preferredName) {
    const stored = voices.find((voice) => voice.name === preferredName);
    if (stored) return stored.name;
  }
  const preferredUsVoiceNames = ["Samantha", "Ava", "Allison", "Evan", "Zoe"];
  for (const name of preferredUsVoiceNames) {
    const match = voices.find((voice) => voice.name === name);
    if (match) return match.name;
  }
  const enUs = voices.find((voice) => voice.lang === "en-US" || voice.lang === "en_US");
  if (enUs) return enUs.name;
  const anyEnglish = voices.find((voice) => (voice.lang || "").toLowerCase().startsWith("en"));
  if (anyEnglish) return anyEnglish.name;
  return voices[0].name;
}
