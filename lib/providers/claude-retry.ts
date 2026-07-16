/**
 * Decide whether a failed claude CLI run should be retried once WITHOUT
 * --resume.
 *
 * Incident 2026-07-05: the workspace-root path migration orphaned the voice
 * thread's stored CLI session (sessions are keyed by project cwd slug), so
 * every turn resumed a session the CLI could no longer find and failed with
 * an error_during_execution result ("No conversation found with session ID").
 * A stale stored session must never brick a thread: drop the resume, run the
 * turn fresh, and let the done event's new session id replace the stored one.
 *
 * Kept as a pure function so the decision is unit-testable without spawning
 * the CLI.
 */

export interface CliFailure {
  /** This attempt passed --resume <id> to the CLI. */
  resumeUsed: boolean;
  /**
   * The attempt already streamed text/tool events to the consumer. Retrying
   * after output was emitted would duplicate it downstream (spoken twice,
   * journaled twice), so those failures are never retried. Session-not-found
   * always fails before any output.
   */
  emittedOutput: boolean;
  /** subtype of the CLI's result event when is_error (e.g. "error_during_execution"). */
  errorSubtype?: string | null;
  /** Best-available error detail: result text, else stderr tail, else exit code. */
  errorDetail: string;
}

const SESSION_NOT_FOUND_RE = /no conversation found with session/i;

export function shouldRetryWithoutResume(f: CliFailure): boolean {
  if (!f.resumeUsed || f.emittedOutput) return false;
  return (
    f.errorSubtype === "error_during_execution" ||
    SESSION_NOT_FOUND_RE.test(f.errorDetail)
  );
}
