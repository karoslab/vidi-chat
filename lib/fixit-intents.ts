import type { FixitCommandId } from "./fixit-registry.ts";

/**
 * Fix-It Mode — the deterministic NL→command grammar (PLAN-VIDI-FIXIT.md §4.1
 * step 1). Anchored, whole-utterance regexes over the NORMALIZED LIVE user
 * transcript, one group per T0 command. This mirrors `matchFleetIntent`'s
 * pattern in lib/agents/intents.ts: a MISS FALLS THROUGH — the matcher never
 * guesses. A mid-sentence mention of a trigger phrase does not fire, because
 * every rule is anchored on the whole utterance.
 *
 * Phase A ships the three T0 commands only (§6): `status.whatsMySetup` (§2.1
 * row 1), `creds.recheck` (§2.1 row 4), `brain.verify` (§2.1 row 7), each with
 * the design-doc trigger phrases plus reasonable variants.
 *
 * INJECTION DEFENSE (§4.3, critical): this matcher must run ONLY on the live
 * user transcript, never on fenced/untrusted content. The caller (voice-turn.ts)
 * guarantees that — it passes the raw live transcript here, and runs
 * `stripLeadingControlTokens` on it first so a spoken/transcribed control marker
 * ("system: …") can't masquerade as a control token. This module does not read
 * any fenced span itself.
 */

export interface FixitIntent {
  kind: "fixit";
  commandId: FixitCommandId;
}

/**
 * Normalize a transcript for grammar matching — the same shape as
 * matchFleetIntent's `normalize`: lowercase, drop sentence punctuation, strip
 * the wake word ("vidi" / "hey vidi" / "ok vidi") and a leading/trailing
 * "please", collapse whitespace. So "Vidi, what's my setup?" and
 * "what's my setup" normalize to the same anchored string.
 */
function normalize(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[.!?,]+/g, " ")
    .replace(/\b(hey |ok )?vidi\b/g, " ")
    .replace(/\bplease\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match the live user transcript against the T0 fix-it grammar. Returns a
 * `FixitIntent` on a confident whole-utterance match, else null (fall through
 * to normal Vidi — never guess-execute).
 *
 * IMPORTANT (§4.3): pass only the LIVE user transcript. This function must
 * never be handed fenced/ingested content — command-shaped text inside a
 * fenced block is DATA and must not fire a command.
 */
export function matchFixitIntent(transcript: string): FixitIntent | null {
  const normalizedTranscript = normalize(transcript);

  // status.whatsMySetup (§2.1 row 1) — the triage anchor command.
  // Doc triggers: "what's my setup", "is everything working", "what's turned
  // on", "check yourself" (+ reasonable variants).
  if (
    /^(?:what(?:'| i)?s my setup|what is my setup|is everything (?:working|okay|ok|alright|all ?right)|are you (?:working|okay|ok|all ?right)|what(?:'| i)?s turned on|what is turned on|check yourself|check your setup|(?:show|tell) me (?:my |your )?setup|status check|run a self ?check|self ?check)$/.test(
      normalizedTranscript
    )
  ) {
    return { kind: "fixit", commandId: "status.whatsMySetup" };
  }

  // creds.recheck (§2.1 row 4) — read-only login liveness probe.
  // Doc triggers: "you can't reach Claude", "the connection's down", "re-check
  // your login", "are you logged in" (+ reasonable variants).
  if (
    /^(?:you can(?:'?t| ?not) reach (?:claude|codex|your brain)|(?:the )?connection(?:'| i)?s down|(?:the )?connection is down|(?:re[\s-]?check|check|recheck) your (?:login|connection|logins)|are you logged in|are you (?:still )?connected|check if you(?:'?re| are) logged in)$/.test(
      normalizedTranscript
    )
  ) {
    return { kind: "fixit", commandId: "creds.recheck" };
  }

  // brain.verify (§2.1 row 7) — read-only memory folder check.
  // Doc triggers: "did you lose my memory", "where are your notes", "check your
  // memory folder", "is your brain okay" (+ reasonable variants).
  if (
    /^(?:did you lose (?:my|your) (?:memory|notes|brain)|where are your notes|where(?:'| i)?s your (?:memory|brain)|check your (?:memory|brain)(?: folder)?|(?:is|are) your (?:brain|memory|notes) (?:okay|ok|alright|all ?right|there|intact)|do you still have (?:my|your) (?:memory|notes))$/.test(
      normalizedTranscript
    )
  ) {
    return { kind: "fixit", commandId: "brain.verify" };
  }

  return null;
}
