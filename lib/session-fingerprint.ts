import { normalizeEffort, normalizeMode } from "./models.ts";

/**
 * Session fingerprint (FIX 1 — mid-thread model/provider/effort/mode switching).
 *
 * A provider CLI session is PINNED to the model / agent / effort it was created
 * with: grok errors "Cannot switch to model X … Start a new session", and
 * codex/claude silently keep the session's original model. So a thread that
 * --resumes its stored session after the user switched model (or effort, or
 * mode, or provider) either 500s or silently ignores the switch.
 *
 * The fix: persist a fingerprint of the settings the stored session was born
 * with, alongside providerSessionId. Before each turn, compare the thread's
 * CURRENT settings to that fingerprint — if any differ, DROP the resume (start a
 * fresh provider session so the switch actually takes effect) and re-stamp the
 * fingerprint from the new turn's settings. If identical, resume as before.
 *
 * The decision is a pure function so it is unit-testable without a spawn; the
 * call sites (chat/voice/goals/fleet) wire it in front of every sendMessage.
 */
export interface SessionFingerprint {
  /** The provider the session belongs to (claude/codex/grok). A cross-provider
   *  switch always forces a fresh session — a claude session id is meaningless
   *  to codex. */
  provider: string;
  /** The model id AS STORED on the thread. For grok this is grok-4.5-chat vs
   *  grok-4.5-build, so a Chat↔Build switch (same underlying grok-4.5 model, a
   *  different agent posture — which grok also requires a fresh session for)
   *  changes the fingerprint too. null = provider default / auto-route. */
  model: string | null;
  /** Normalized reasoning effort (low|medium|high|xhigh|max|ultra). */
  effort: string;
  /** Normalized thread mode (plan|auto). */
  mode: string;
}

/** Build a fingerprint from a thread's stored settings (normalized so cosmetic
 *  differences — a missing effort, a legacy "act" mode — never force a spurious
 *  fresh session). */
export function computeFingerprint(t: {
  provider: string;
  model?: string | null;
  effort?: string | null;
  mode?: string | null;
}): SessionFingerprint {
  return {
    provider: t.provider,
    model: t.model ?? null,
    effort: normalizeEffort(t.effort),
    mode: normalizeMode(t.mode),
  };
}

export function fingerprintsMatch(
  a: SessionFingerprint,
  b: SessionFingerprint
): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.mode === b.mode
  );
}

/**
 * Should this turn --resume the thread's stored provider session?
 *   - No stored session id → nothing to resume (false).
 *   - A stored session but NO fingerprint → a legacy thread from before this
 *     feature; preserve its resume continuity (true) and let the done event
 *     stamp a fingerprint for next time (mirrors the sessionAccountId legacy
 *     convention in claude.ts).
 *   - Otherwise resume only when the current settings still match the
 *     fingerprint the session was created with.
 */
export function shouldResumeSession(args: {
  priorProviderSessionId: string | null | undefined;
  storedFingerprint: SessionFingerprint | null | undefined;
  current: SessionFingerprint;
}): boolean {
  if (!args.priorProviderSessionId) return false;
  if (!args.storedFingerprint) return true;
  return fingerprintsMatch(args.storedFingerprint, args.current);
}
