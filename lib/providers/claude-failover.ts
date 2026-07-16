/**
 * Pure helpers for multi-account failover in the claude provider. Kept
 * dependency-free (no fs/spawn) so they are unit-testable under `node --test`
 * without importing the provider chain (which uses extensionless imports that
 * the test runner can't resolve — see tests/agent-transitions.test.ts).
 */

/**
 * A CLI failure is a "limit" error (Fable-5 / usage cap / out of credits) —
 * the class of error that another logged-in account can recover, unlike a
 * stale session or a not-logged-in profile. Matches the CLI's own wording:
 *   "You've reached your Fable 5 limit. Run /usage-credits to continue…"
 *   "usage limit reached", "out of credits", etc.
 */
const LIMIT_RE = /reached your .*limit|usage limit|out of .*credits|\/usage-credits/i;

export function isLimitError(detail: string | null | undefined): boolean {
  return typeof detail === "string" && LIMIT_RE.test(detail);
}

/**
 * A CLI failure that means the ACCOUNT is unusable — never logged in, logged
 * out, or dead credentials. Another account can still recover the turn, but
 * this one must be skipped AND never persisted as active (2026-07-05: a
 * failover landed on the never-logged-in alt profile and stuck there).
 * Exact CLI wording, captured that day: "Not logged in · Please run /login".
 */
const LOGIN_RE =
  /not logged in|please run \/login|invalid api key|oauth token (revoked|expired)|(organization|org) has disabled .*(subscription|access)|disabled claude subscription access/i;

export function isLoginError(detail: string | null | undefined): boolean {
  return typeof detail === "string" && LOGIN_RE.test(detail);
}

export interface AccountLite {
  id: string;
  label: string;
}

/**
 * Given the full registry (in order), the account that just failed, and the
 * set already tried this turn, return the next account to try — or null when
 * every account has been tried. Registry order IS the failover order; the
 * account that hit the limit is skipped.
 */
export function nextAccount(
  registry: AccountLite[],
  triedIds: ReadonlySet<string>
): AccountLite | null {
  for (const a of registry) {
    if (!triedIds.has(a.id)) return a;
  }
  return null;
}
