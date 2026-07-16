/**
 * Pure validation for a CUSTOM (free-text) agent name typed in the spawn
 * picker (T1.2). The fleet manager's pickName() keeps only [a-zA-Z] and
 * title-cases the result, so a name with spaces, digits, or accents is
 * silently reshaped ("María" → "Mara", "Zoë-2" → "Zo"). Rather than surprise
 * the user, the picker validates BEFORE spawn and shows a plain-language note.
 *
 * No React, no I/O — unit-tested. Mirrors the exact transform pickName applies
 * so the preview the user sees is what the backend will actually store.
 */

export interface AgentNameValidation {
  /** True when the input can be spawned as-is (letters only, non-empty). */
  ok: boolean;
  /** What the backend will actually store (letters kept, title-cased). Empty
   *  string when nothing usable remains. */
  cleaned: string;
  /** A plain-language note to show the user, or null when the input is clean. */
  note: string | null;
}

/** The exact transform lib/agents/manager.ts#pickName applies to an explicit
 *  name: drop everything but ASCII letters, then title-case. Kept in sync by
 *  hand — if pickName changes, change this. */
function cleanLikeBackend(rawName: string): string {
  const lettersOnly = rawName.replace(/[^a-zA-Z]/g, "");
  if (!lettersOnly) return "";
  return lettersOnly[0].toUpperCase() + lettersOnly.slice(1).toLowerCase();
}

/**
 * Validate a custom name. An empty field is "ok" (spawn with an auto-picked
 * curated name — the field is optional), so only NON-empty input is checked.
 */
export function validateCustomAgentName(rawName: string): AgentNameValidation {
  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    // Optional field: no custom name → the backend picks a curated one.
    return { ok: true, cleaned: "", note: null };
  }

  const cleaned = cleanLikeBackend(trimmed);
  if (cleaned.length === 0) {
    return {
      ok: false,
      cleaned: "",
      note: "A name needs at least one letter (a–z).",
    };
  }

  // The letters-only projection differs from what was typed → the backend will
  // reshape it. Tell the user plainly what it will actually be called.
  const strippedSomething = cleaned.toLowerCase() !== trimmed.replace(/\s+/g, "").toLowerCase();
  if (strippedSomething) {
    return {
      ok: true,
      cleaned,
      note: `I'll call it "${cleaned}" (names use letters only).`,
    };
  }

  return { ok: true, cleaned, note: null };
}
