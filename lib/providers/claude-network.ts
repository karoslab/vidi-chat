/**
 * Classify a claude CLI failure as a transient NETWORK-class error and map it to
 * a plain-language message in Vidi's voice.
 *
 * The CLI surfaces raw connectivity failures verbatim — e.g.
 *   "Connection problem. Check your internet connection, VPN, or proxy and try
 *    again."
 * and lower-level node/undici strings ("fetch failed", "ECONNRESET",
 * "ENOTFOUND", "ETIMEDOUT", "socket hang up"). Before Phase B these passed
 * straight through into the chat bubble. We now (a) retry ONCE silently when the
 * failure is network-class AND nothing streamed yet, and (b) if it still fails,
 * show this friendly line instead of the raw string (the raw detail stays in the
 * server log / diagnostics for support).
 *
 * Pure + dependency-free so it is unit-testable without spawning the CLI (same
 * pattern as claude-failover / claude-retry). This is DISTINCT from a usage
 * limit (isLimitError) or a not-logged-in account (isLoginError): those recover
 * by rotating accounts; a network error recovers by simply trying again.
 */

const NETWORK_RE =
  /connection problem|connection (?:error|refused|reset|timed out)|check your internet|econnreset|econnrefused|econnaborted|enotfound|etimedout|enetunreach|ehostunreach|eai_again|getaddrinfo|socket hang ?up|fetch failed|network (?:error|is unreachable)|could not (?:connect|reach)|proxy/i;

export function isNetworkError(detail: string | null | undefined): boolean {
  return typeof detail === "string" && NETWORK_RE.test(detail);
}

export interface NetworkRetryDecision {
  /** Best-available error detail (result text / stderr tail / exit code). */
  errorDetail: string;
  /**
   * This attempt already streamed text/tool events. Retrying after output was
   * emitted would DOUBLE-APPLY the turn (spoken twice, journaled twice), so a
   * partial-streamed failure is never retried — same rule as claude-retry.
   */
  emittedOutput: boolean;
  /** The one automatic network retry for this turn was already spent. */
  alreadyRetried: boolean;
}

/**
 * Whether a failed run should get the ONE automatic silent network retry:
 * network-class error, nothing streamed yet, and the retry hasn't been spent.
 * Pure so the "streamed-partial NOT retried, clean network failure retried once"
 * contract is unit-testable without a spawn.
 */
export function shouldRetryNetwork(d: NetworkRetryDecision): boolean {
  if (d.emittedOutput || d.alreadyRetried) return false;
  return isNetworkError(d.errorDetail);
}

/**
 * The plain-language, persona-voiced message shown to the customer after the one
 * silent retry also failed. No dashes; the raw CLI error is NOT included (it is
 * preserved in the server log + diagnostics instead).
 */
export const FRIENDLY_NETWORK_MESSAGE =
  "I could not reach my brain just now. Check your internet and try once more.";
