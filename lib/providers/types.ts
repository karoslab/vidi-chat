/**
 * A BrainProvider wraps a locally-authenticated CLI (claude, codex) behind one
 * interface. No API keys anywhere — each provider spawns a subscription-authed
 * binary and streams its output back.
 */

/** Per-turn usage parsed from the CLI's own result event (also written to
 *  the data/quota.jsonl ledger by the provider). costUsd is API-equivalent
 *  cost, not money spent — subscription auth. Convention: inputTokens is
 *  NON-cached input only (codex reports cached inside input_tokens; the
 *  adapter subtracts it so windows sum comparably across providers). */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export type ProviderStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; tool: string; summary: string }
  // Honest "reasoning happened" signal — never redacted text. The claude CLI
  // (2.1.195) redacts thinking TEXT, but two real signals survive: the boolean
  // presence of a type=="thinking" content_block, and the numeric
  // usage.output_tokens_details.thinking_tokens on the per-message message_delta
  // event (absent from the final result event). Emitted once per turn, only
  // when the turn actually reasoned.
  | { type: "reasoning"; reasoned: true; tokens?: number }
  | {
      type: "done";
      providerSessionId: string | null;
      /**
       * Account id that produced this turn (claude provider). Stored on the
       * thread alongside providerSessionId so a later turn on a different
       * account knows the session is foreign and skips --resume. When a
       * failover switched accounts mid-turn, this is the account that
       * SUCCEEDED, not the one the turn started on.
       */
      accountId?: string | null;
      fullText: string;
      usage?: RunUsage;
      /**
       * Honest "the stop button cut this short" signal (never inferred from
       * text) — set only by an onAbort handler emitting the partial answer
       * as a done instead of discarding it. Absent means the turn finished
       * on its own.
       */
      stopped?: true;
    }
  | {
      type: "error";
      message: string;
      usage?: RunUsage;
      /**
       * The stored provider session id was rejected by the CLI (stale after a
       * workspace rename etc.) and a fresh no-resume retry ALSO failed.
       * Callers must null the thread's providerSessionId so the next turn
       * starts clean instead of re-paying a doomed resume attempt. (When the
       * retry succeeds, the done event's new session id replaces it instead.)
       */
      resetProviderSession?: boolean;
    };

/**
 * The two real modes are "plan" (read-only research + planning, runs the CLI
 * in --permission-mode plan) and "auto" (write tools behind the trust dial).
 * "chat" and "act" are legacy aliases from pre-harness threads: chat→plan,
 * act→auto (normalized in lib/models.ts).
 */
export type ThreadMode = "plan" | "auto" | "chat" | "act";

export interface SendMessageArgs {
  threadId: string;
  /** Provider-native session id from the previous turn, for continuity. */
  priorProviderSessionId?: string | null;
  /**
   * Account id that CREATED priorProviderSessionId (claude provider only). A
   * CLI session belongs to the config dir that made it, so if the active
   * account differs from this one, the provider must NOT --resume the stale id
   * — it starts a fresh session instead. Absent/null on legacy threads means
   * "unknown origin"; treated as owned by the active account so pre-existing
   * threads keep their resume continuity.
   */
  sessionAccountId?: string | null;
  userMessage: string;
  /**
   * Provider-specific model id; "auto"/null lets the router pick (fable for
   * deep turns, sonnet/opus otherwise — see lib/models.ts).
   */
  model?: string | null;
  /**
   * "plan" (default) = read-only planning. "auto" = write tools with the
   * trust dial (claude provider only; codex ignores this, stays read-only).
   */
  mode?: ThreadMode;
  /** Reasoning effort dial; becomes a real --effort CLI flag (ultra→max). */
  effort?: string;
  /** Extra system-prompt text appended after the persona (e.g. voice mode). */
  extraSystemText?: string;
  /**
   * Extra environment variables merged into the spawned CLI child's env (on top
   * of process.env). Used by the fleet manager to stamp VIDI_AGENT_ID /
   * VIDI_AGENT_DEPTH so a spawned agent's vidictl calls identify their caller —
   * which enforces spawn-depth (Phase 4a — H10). Absent for ordinary turns.
   */
  childEnv?: Record<string, string>;
  /**
   * Aborting this signal SIGKILLs the CLI child; the generator ends with a
   * done event carrying whatever text had streamed so far and
   * `stopped: true` (never a bare error — the explicit stop button is a
   * normal way for a turn to end, not a failure). Wired to POST
   * /api/threads/[id]/stop via lib/turn-abort.ts, registered only while the
   * turn holds withTurnLock (lib/store.ts).
   */
  signal?: AbortSignal;
}

export interface ProviderModel {
  id: string;
  label: string;
  default?: boolean;
}

export interface ProviderAvailability {
  ok: boolean;
  /** Human-readable reason shown in the UI when ok === false. */
  reason?: string;
}

export interface BrainProvider {
  id: string;
  label: string;
  models: ProviderModel[];
  available(): Promise<ProviderAvailability>;
  sendMessage(args: SendMessageArgs): AsyncGenerator<ProviderStreamEvent>;
}
