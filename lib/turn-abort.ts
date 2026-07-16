/**
 * Per-thread stop button. A different concern from lib/kill.ts's panic switch
 * (which SIGKILLs every registered child AND writes a persistent file that
 * blocks all future runs): this only ever targets the ONE turn currently
 * running on ONE thread, and stopping it grants nothing back — there's
 * nothing to re-arm.
 *
 * app/api/chat/route.ts already builds an AbortController per turn and wires
 * it into provider.sendMessage's `signal` (claude.ts/codex.ts both kill their
 * CLI child and end the generator on abort) — it just had no way for a
 * separate HTTP request to reach that controller. This registry is that
 * bridge: registered only while the turn actually holds the per-thread
 * withTurnLock (lib/store.ts), so it always names the turn genuinely running
 * for a thread, never one still queued behind an earlier turn.
 */

// Stashed on globalThis so next-dev HMR doesn't fork the registry.
const controllers: Map<string, AbortController> = ((
  globalThis as Record<string, any>
).__vidiTurnAborts ??= new Map());

/** Track the controller for a thread's in-flight turn; returns the deregister function. */
export function registerTurnAbort(threadId: string, controller: AbortController): () => void {
  controllers.set(threadId, controller);
  return () => {
    if (controllers.get(threadId) === controller) controllers.delete(threadId);
  };
}

/** Abort the turn currently running on this thread, if any. Returns whether one was found. */
export function stopTurn(threadId: string): boolean {
  const controller = controllers.get(threadId);
  if (!controller) return false;
  controller.abort();
  return true;
}
