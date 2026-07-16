/**
 * Plain-language error boundary for provider/CLI failures (T1.4).
 *
 * The claude/codex providers surface real failures as error events whose
 * `message` carries raw CLI detail ("claude CLI error: <500 chars of stderr>",
 * "failed to spawn claude CLI: ENOENT …"). That text is fine for the SERVER
 * LOG but must never reach the UI or TTS — a non-owner second user should see a
 * calm, human sentence, not a stack trace or a CLI flag.
 *
 * This is a pure classifier: it maps a raw provider error string to one of a
 * few friendly messages by recognizing the known failure classes, and falls
 * back to a generic line for anything unrecognized. No I/O — unit-tested. The
 * caller is responsible for logging the raw text before calling this.
 */

/**
 * A friendly one-liner for a raw provider/CLI error message. Deliberately
 * small and honest: it names the class of problem the user can act on (usage
 * limit, not logged in) and otherwise says "something went wrong, try again"
 * without ever echoing CLI internals.
 */
export function plainLanguageProviderError(rawMessage: string | undefined | null): string {
  const raw = (rawMessage ?? "").toLowerCase();

  // Usage/quota exhaustion (a Pro/subscription rate limit hit mid-turn): the
  // user can wait for the reset or upgrade for more. No raw stderr, no CLI flag.
  if (raw.includes("usage limit") || raw.includes("usage-credits") || raw.includes("reached its usage")) {
    return "I've hit my usage limit for now. Wait a little and try again, or upgrade your plan for more.";
  }

  // Not logged in — the account isn't connected. Point at the in-app connect
  // step (Setup), where a non-technical user installs and signs in right here.
  if (raw.includes("not logged in") || raw.includes("no configured account is logged in") || raw.includes("/login")) {
    return "I'm not signed in to my AI account right now. Open Setup and connect it there, then try again.";
  }

  // The CLI couldn't be started at all (missing binary, bad path) — a spawn
  // crash. Never surface the stack / ENOENT / path.
  if (raw.includes("failed to spawn") || raw.includes("enoent")) {
    return "I couldn't start my AI just now. Try again in a moment.";
  }

  // A run was aborted / killed for inactivity.
  if (raw.includes("run aborted") || raw.includes("killed")) {
    return "That took too long so I stopped it. Try again, maybe with a smaller ask.";
  }

  // Anything else (a raw "claude CLI error: …", an internal error): generic.
  return "Something went wrong on my end. Try that again in a moment.";
}
