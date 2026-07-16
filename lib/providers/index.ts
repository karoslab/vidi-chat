import type {
  BrainProvider,
  ProviderStreamEvent,
  SendMessageArgs,
} from "./types.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { grokProvider } from "./grok.ts";
import { CircuitBreaker } from "../circuit-breaker.ts";
import { appendJournal } from "../journal.ts";
import { acpProvider, acpConfigured } from "./acp.ts";

const rawProviders: Record<string, BrainProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  grok: grokProvider,
  // ACP has no default binary — register it ONLY when an agent is explicitly
  // configured (ACP_AGENT_BIN), so getProvider("acp") is null unless opted in.
  ...(acpConfigured() ? { acp: acpProvider } : {}),
};

// One breaker per provider id, shared across every turn in this process — a
// wedged CLI trips its provider's breaker for the whole fleet, not per thread.
const breakers = new Map<string, CircuitBreaker>();
export function breakerFor(id: string): CircuitBreaker {
  let b = breakers.get(id);
  if (!b) breakers.set(id, (b = new CircuitBreaker()));
  return b;
}

/**
 * Guard a provider's sendMessage with its circuit breaker. When the breaker is
 * open the turn fails fast with a clear error + journal line instead of
 * spawning another doomed CLI session; otherwise the turn runs and its terminal
 * outcome (an `error` event = failure, anything else = success) feeds the
 * breaker so it can trip, probe, and recover.
 */
export function withBreaker(provider: BrainProvider): BrainProvider {
  return {
    ...provider,
    async *sendMessage(
      args: SendMessageArgs
    ): AsyncGenerator<ProviderStreamEvent> {
      const breaker = breakerFor(provider.id);
      if (!breaker.allow()) {
        appendJournal({
          ts: Date.now(),
          threadId: args.threadId,
          tool: "circuit-breaker",
          summary: `${provider.id}: breaker open — skipping turn to stop burning tokens`,
        });
        yield {
          type: "error",
          message: `The ${provider.label} CLI has been failing repeatedly, so I'm pausing it for a moment rather than starting another doomed session. It will retry automatically shortly.`,
        };
        return;
      }
      // The breaker admitted this turn (maybe as the half-open probe), so it
      // MUST be told the turn ended exactly once — on EVERY teardown path,
      // including when a consumer abandons this generator early (breaks/throws
      // out of its own loop, e.g. lib/memory-wiki.ts rethrowing an error event).
      // The runtime then `.return()`s us at the suspended `yield`, running only
      // finally blocks — so settling in `finally` is load-bearing: without it a
      // half-open probe that was abandoned would leave the breaker stuck
      // half-open forever, failing the provider fleet-wide until restart.
      let failed = false;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (failed) breaker.recordFailure();
        else breaker.recordSuccess();
      };
      try {
        for await (const ev of provider.sendMessage(args)) {
          if (ev.type === "error") failed = true;
          yield ev;
        }
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        settle();
      }
    },
  };
}

export const providers: Record<string, BrainProvider> = Object.fromEntries(
  Object.entries(rawProviders).map(([id, p]) => [id, withBreaker(p)])
);

export function getProvider(id: string): BrainProvider | null {
  return providers[id] ?? null;
}
