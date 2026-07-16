import fs from "node:fs";
import path from "node:path";
import {
  _resetUserConfigCache,
  DISPLAY_NAME_MAX_LENGTH,
  sanitizeDisplayName,
} from "./user-config.ts";
import { dataDir, secureDataFile } from "./data-dir.ts";

/**
 * First-run onboarding state (P4.1 — the second-user tier).
 *
 * A brand-new install has no threads and no profile, so the UI shows the
 * onboarding flow once: name → personality → a plain-language capability +
 * permissions walkthrough → a "what you can say" starter card.
 *
 * The hard constraint: an EXISTING install (the owner's, 40+ threads) must
 * NEVER see onboarding. So "onboarded" is true if ANY of these hold:
 *   1. the onboarded flag file exists (written when a user finishes the flow,
 *      or proactively for an existing install), OR
 *   2. there is pre-existing data — one or more saved threads. Presence of a
 *      real conversation history means this person has already been using Vidi;
 *      onboarding them would be absurd. This is the "existing data =
 *      onboarded" rule, and it protects the owner even before the flag is
 *      written.
 *
 * Everything lives under data/ (gitignored, per-install), matching the rest of
 * the app's plain-JSON storage.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) so tests can chdir into a temp dir per case and a fresh-install
// rehearsal can point at an empty dir — matching goals.ts's data/ writers.
const onboardedFlagPath = () => path.join(dataDir(), "onboarded.json");
const profilePath = () => path.join(dataDir(), "profile.json");
const threadsDir = () => path.join(dataDir(), "threads");
const userConfigPath = () => path.join(dataDir(), "user-config.json");

/** Personalities the onboarding offers. Purely a stored tone preference the
 *  persona layer can read later; not a new voice system (TTS voice is ara,
 *  server-side). Kept small and honest. */
export const PERSONALITIES = [
  { id: "warm", label: "Warm & encouraging", blurb: "Friendly, patient, celebrates small wins." },
  { id: "direct", label: "Direct & efficient", blurb: "Straight to the point, minimal chit-chat." },
  { id: "playful", label: "Playful", blurb: "Light, a little witty, keeps it fun." },
] as const;

export type PersonalityId = (typeof PERSONALITIES)[number]["id"];

/**
 * The five "what you can say" starter prompts. Single source of truth shared by
 * the onboarding starter step (Onboarding.tsx) and the intro chat's tappable
 * cards (T2.2) so the two never drift. Plain, everyday asks that show the range
 * (read, remember, draft, plan, recall) without any owner-specific detail.
 */
export const STARTER_PROMPTS: readonly string[] = [
  "Summarize what's in this folder.",
  "Remember that my sister's birthday is in May.",
  "Draft a note to my landlord about the leak.",
  "Help me plan a simple website for my idea.",
  "What did we talk about yesterday?",
] as const;

/**
 * A one-line tone instruction per personality, appended to the system prompt
 * when the user picked one during onboarding. Deliberately small: it nudges
 * TONE only and never overrides the substance/behavior rules that precede it
 * (voice length, commitment markers, ask-before-risky). Framed as guidance for
 * how to phrase, not what to do.
 */
const PERSONALITY_TONE_BLOCKS: Record<PersonalityId, string> = {
  warm: "Tone: warm and encouraging — friendly and patient, notice small wins, never gushing.",
  direct: "Tone: direct and efficient — straight to the point, minimal chit-chat, no filler.",
  playful: "Tone: playful — light and a little witty, keep it fun without being silly or slowing things down.",
};

/**
 * The tone block to append to the system prompt for a stored personality.
 * Returns null when there's no profile or the personality is unrecognized —
 * the ABSENCE case, which must leave the prompt byte-identical to today's
 * default. Pure (takes the profile, no I/O) so it's unit-testable and the
 * caller controls when the profile is read.
 */
export function personaToneBlock(profile: Profile | null): string | null {
  if (!profile) return null;
  return PERSONALITY_TONE_BLOCKS[profile.personality] ?? null;
}

export interface Profile {
  name: string;
  personality: PersonalityId;
  createdAt: number;
}

/** True when at least one saved thread exists — the "existing data" signal. */
function hasExistingThreads(): boolean {
  try {
    return fs.readdirSync(threadsDir()).some((f) => f.endsWith(".json"));
  } catch {
    return false; // no threads dir yet → fresh install
  }
}

function flagExists(): boolean {
  try {
    return fs.existsSync(onboardedFlagPath());
  } catch {
    return false;
  }
}

/** The single gate the UI/route consults. */
export function isOnboarded(): boolean {
  return flagExists() || hasExistingThreads();
}

export function readProfile(): Profile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath(), "utf8"));
    if (parsed && typeof parsed.name === "string") return parsed as Profile;
  } catch {
    /* no profile yet */
  }
  return null;
}

/** Write the onboarded flag. Idempotent; fail-open (a flag write must never
 *  break a turn). Records how the flag came to be for provenance. */
export function markOnboarded(source: "flow" | "existing-install"): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(
      onboardedFlagPath(),
      JSON.stringify({ onboarded: true, source, at: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Boot-time backfill: if this install already has data (saved threads) but no
 * onboarded flag yet, write the flag proactively so an EXISTING user (the
 * owner) is marked onboarded and can never see the first-run flow. A truly fresh
 * install has no threads, so this is a no-op there. Called from instrumentation
 * at server startup. Fail-open — the existing-data rule still gates the UI even
 * if this never runs.
 */
export function ensureExistingInstallOnboarded(): void {
  if (hasExistingThreads() && !flagExists()) {
    markOnboarded("existing-install");
  }
}

export interface CompleteOnboardingInput {
  name: string;
  personality: PersonalityId;
}

/**
 * Finish the onboarding flow for a NEW user: persist the profile, set the
 * display name in user-config.json (so the greeting and recall labels use it),
 * and set the onboarded flag. Returns the saved profile.
 *
 * Deliberately does NOT touch anything for an already-onboarded install — the
 * route guards on isOnboarded() before ever calling this, so the owner's
 * config is never rewritten.
 */
export function completeOnboarding(input: CompleteOnboardingInput): Profile {
  // Same sanitize as the settings-panel write path: the name feeds LLM prompt
  // strings, so strip control chars/newlines before capping and storing.
  const name = sanitizeDisplayName(input.name).slice(0, DISPLAY_NAME_MAX_LENGTH) || "there";
  const personality: PersonalityId = PERSONALITIES.some((p) => p.id === input.personality)
    ? input.personality
    : "warm";
  const profile: Profile = { name, personality, createdAt: Date.now() };

  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2));
  secureDataFile(profilePath()); // H10: 0600 profile (name/personality) + 0700 data/

  // Set the display name in the user-config seam so the rest of the app
  // addresses her by name. Merge (never clobber) any existing overrides.
  let existingConfig: Record<string, unknown> = {};
  try {
    existingConfig = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
  } catch {
    /* first write */
  }
  fs.writeFileSync(
    userConfigPath(),
    JSON.stringify({ ...existingConfig, displayName: name }, null, 2)
  );
  _resetUserConfigCache(); // the new name takes effect without a restart

  markOnboarded("flow");
  return profile;
}
