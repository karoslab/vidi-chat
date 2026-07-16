/**
 * Live-turn buffer — server-side "resumable streams" for chat.
 *
 * Streamed deltas otherwise live only in the client's React state: navigate
 * to /canvas and back mid-turn and everything already streamed (including the
 * failover "⚠ … switched to …" notice) is gone, because the server only
 * persists the assistant message at turn end (app/api/chat/route.ts,
 * withTurnLock). This module keeps the text accumulated so far in memory,
 * keyed by threadId, so the reconnect poll (GET /api/threads/[id]) can replay
 * it and the in-progress bubble survives a page round-trip.
 *
 * Same shape as the kill-switch run registry (lib/kill.ts): a module-level
 * Map stashed on globalThis so next-dev HMR doesn't fork it. In-process only —
 * a single launchd/next process owns data/, and this never touches disk (the
 * turn's FINAL text still persists to the thread the normal way; this is the
 * transient in-flight mirror, cleared the moment the turn ends).
 */

export interface LivePartial {
  /** Text streamed so far this turn, INCLUDING any failover switch notice. */
  text: string;
  startedAt: number;
  updatedAt: number;
}

const buffers: Map<string, LivePartial> = ((
  globalThis as Record<string, any>
).__vidiLiveBuffer ??= new Map());

/**
 * Append a streamed chunk to a thread's live buffer, creating it on first
 * write. Pass the same text that streams to the client (deltas AND the
 * prepended failover notice) so a reconnecting client sees exactly what a
 * connected one did.
 */
export function appendLive(threadId: string, text: string): void {
  if (!text) return;
  const now = Date.now();
  const cur = buffers.get(threadId);
  if (cur) {
    cur.text += text;
    cur.updatedAt = now;
  } else {
    buffers.set(threadId, { text, startedAt: now, updatedAt: now });
  }
}

/** The live partial for a thread, or null when no turn is buffering. */
export function getLive(threadId: string): LivePartial | null {
  return buffers.get(threadId) ?? null;
}

/** Drop a thread's buffer — call the moment the turn completes or errors. */
export function clearLive(threadId: string): void {
  buffers.delete(threadId);
}
