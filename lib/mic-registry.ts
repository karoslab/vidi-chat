/**
 * Mic registry — the single, provable source of truth for "is the microphone
 * captured right now, and by whom".
 *
 * Why this exists (2026-07-12, top-severity trust fix):
 * A customer reported that after using voice ONCE, Safari's orange mic
 * indicator stayed lit for as long as the app was open ("its set to always
 * listening. Its creepy."). The browser capture path is the Web Speech API
 * (`webkitSpeechRecognition`), not a getUserMedia stream, and the ONLY release
 * path relied on the browser firing `onend`/`onerror`. There is no
 * always-listening mode — capture is single-utterance push-to-talk — but if
 * WebKit is slow to (or never) fires the terminal event, nothing forced the
 * audio session closed, so the indicator lingered.
 *
 * This module makes the release provable and gives us a hard panic path:
 *   - every mic owner takes a tagged lease on acquire and drops it on release;
 *   - `hasLiveMic()` / `activeMicOwners()` let tests assert zero live owners
 *     after every terminal path (turn end, cancel, toggle off, error mid-turn,
 *     and while TTS playback continues after the user stops talking);
 *   - `panicMicRelease()` (wired to the persona Pause pill, pagehide, and the
 *     tab going hidden) fires every registered teardown handler AND drops every
 *     lease, so the mic is released unconditionally, not just when the browser
 *     decides to tell us the turn ended.
 *
 * No DOM dependency: it holds bookkeeping only. The actual "stop the hardware"
 * work lives in the owner's panic handler (see lib/voice-mic-session.ts), which
 * this module invokes. That keeps the registry pure and unit-testable.
 */

export type MicLease = {
  /** Human-readable owner tag, e.g. "voice-chat". Not required to be unique. */
  readonly tag: string;
  /** Unique lease id (stable for the lifetime of this capture). */
  readonly id: number;
  /** Idempotent. Dropping a lease twice is safe and a no-op the second time. */
  release(): void;
  /** True until release() has run. */
  readonly active: boolean;
};

type LeaseRecord = { tag: string; id: number; active: boolean };

let seq = 0;
const leases = new Map<number, LeaseRecord>();
const panicHandlers = new Set<(reason: string) => void>();

/**
 * Take a mic lease. Call this the moment capture starts (before/at
 * `recognition.start()`), so the registry reflects the hardware state.
 */
export function acquireMic(tag: string): MicLease {
  const id = ++seq;
  const rec: LeaseRecord = { tag, id, active: true };
  leases.set(id, rec);
  const lease: MicLease = {
    tag,
    id,
    get active() {
      return rec.active;
    },
    release() {
      if (!rec.active) return;
      rec.active = false;
      leases.delete(id);
    },
  };
  return lease;
}

/** True if any owner currently holds a live mic lease. */
export function hasLiveMic(): boolean {
  return leases.size > 0;
}

/** Owner tags for every live lease (for assertions / diagnostics). */
export function activeMicOwners(): string[] {
  return Array.from(leases.values(), (l) => l.tag);
}

/** Number of live mic leases. */
export function liveMicCount(): number {
  return leases.size;
}

/**
 * Register a teardown handler that physically stops capture (stop → detach →
 * abort → drop the recognition object). `panicMicRelease` calls every handler.
 * Returns an unsubscribe function; call it when the owner unmounts.
 */
export function onMicPanic(handler: (reason: string) => void): () => void {
  panicHandlers.add(handler);
  return () => {
    panicHandlers.delete(handler);
  };
}

/**
 * Emergency, unconditional release of every mic owner. Fires each registered
 * panic handler (which should tear its own recognition down and drop its
 * lease) and then force-drops any lease still standing, so the registry is
 * guaranteed empty afterward regardless of what the browser did. Wired to the
 * Pause pill, `pagehide`, and the tab going hidden.
 */
export function panicMicRelease(reason = "panic"): void {
  for (const handler of Array.from(panicHandlers)) {
    try {
      handler(reason);
    } catch {
      /* one owner's failure must not block the others */
    }
  }
  // Backstop: anything that didn't drop its own lease gets force-dropped.
  leases.clear();
}

/** Test-only: wipe all registry state so cases don't bleed into each other. */
export function __resetMicRegistryForTests(): void {
  leases.clear();
  panicHandlers.clear();
  seq = 0;
}
