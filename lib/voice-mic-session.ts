/**
 * Session-scoped voice mic controller.
 *
 * Policy (2026-07-12 trust fix): the microphone is captured ONLY while the user
 * is actively speaking a turn (push-to-talk), and every terminal path releases
 * it unconditionally — the browser indicator MUST go dark between turns.
 * Re-acquiring on the next turn is allowed to re-prompt / lag slightly; privacy
 * beats warm-start latency. There is deliberately NO hands-free / always-
 * listening mode: capture is single-utterance (`continuous = false`).
 *
 * The bug this closes: the previous teardown ran only from the browser's
 * `onend` / `onerror` callbacks. If WebKit is slow to fire (or never fires)
 * that terminal event, capture — and Safari's orange mic indicator — stayed
 * alive for the life of the page. This controller instead:
 *   - takes a registry lease at `start()` and releases it in ONE idempotent
 *     `teardown()` that runs from every path (graceful stop, cancel, error,
 *     idle backstop, and panic), independent of whether the browser fires
 *     `onend`;
 *   - arms an idle backstop: after `idleMs` of an open mic it calls stop(),
 *     then a short watchdog force-tears-down if `onend` never arrives;
 *   - registers a panic handler so the Pause pill / pagehide / tab-hidden can
 *     kill the mic instantly.
 *
 * It is framework-agnostic and takes an injectable recognition factory, so the
 * whole lifecycle is unit-testable with a fake recognition object and the mic
 * registry asserted directly.
 */

import { acquireMic, onMicPanic, type MicLease } from "./mic-registry.ts";

/** The slice of the Web Speech API we depend on (SpeechRecognition). */
export type MicRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type MicSessionOptions = {
  /** Returns a fresh recognition object, or null if speech isn't supported. */
  createRecognition: () => MicRecognition | null;
  /** Live (interim + final-so-far) transcript while listening; "" on end. */
  onInterim?: (text: string) => void;
  /** The finished utterance — fired once, after the mic is already released. */
  onFinal?: (text: string) => void;
  /** Mic state for the UI: "listening" on start, "idle" when nothing to send. */
  onStateChange?: (state: "idle" | "listening") => void;
  /** Recognition error kind (e.g. "not-allowed", "no-speech"). */
  onError?: (kind: string) => void;
  /** Owner tag recorded in the mic registry. */
  tag?: string;
  /** Idle backstop: force-stop an open mic after this long. Default 20s. */
  idleMs?: number;
  /** Grace after a stop() before we force teardown if onend never fires. */
  watchdogMs?: number;
  /** Injectable timers (tests drive them manually). Default global timers. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
};

export type MicSession = {
  /** Begin capture. No-op if already listening. */
  start(): void;
  /** Finish gracefully — deliver what was heard, then release. */
  stop(): void;
  /** Hard cancel — release immediately, deliver nothing. */
  cancel(reason?: string): void;
  /** Detach the panic handler; call on unmount. */
  dispose(): void;
  /** True while the mic is captured. */
  readonly listening: boolean;
};

export function createMicSession(opts: MicSessionOptions): MicSession {
  const tag = opts.tag ?? "voice-chat";
  const idleMs = opts.idleMs ?? 20_000;
  const watchdogMs = opts.watchdogMs ?? 1_500;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  let rec: MicRecognition | null = null;
  let lease: MicLease | null = null;
  let finalText = "";
  let idleTimer: TimerHandle | null = null;
  let watchdog: TimerHandle | null = null;
  let listening = false;

  function clearTimers() {
    if (idleTimer != null) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
    if (watchdog != null) {
      clearTimer(watchdog);
      watchdog = null;
    }
  }

  /**
   * The one release path. Idempotent. Runs the strongest teardown WebKit
   * respects (stop → detach handlers → abort → drop the object) and, crucially,
   * ALWAYS drops the registry lease — so the mic is provably released even if
   * the browser never fires onend.
   */
  function teardown() {
    clearTimers();
    const r = rec;
    rec = null;
    if (r) {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      try {
        r.abort();
      } catch {
        /* already gone */
      }
    }
    if (lease) {
      lease.release();
      lease = null;
    }
    listening = false;
  }

  function start() {
    if (listening) return;
    const r = opts.createRecognition();
    if (!r) return;
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false; // single-utterance push-to-talk; never hands-free
    r.maxAlternatives = 1;
    finalText = "";

    r.onresult = (e: any) => {
      let interim = "";
      for (const res of e.results) {
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      opts.onInterim?.((finalText + interim).trim());
    };
    r.onerror = (e: any) => {
      const kind = e?.error || "unknown";
      finalText = "";
      teardown();
      opts.onError?.(kind);
      opts.onStateChange?.("idle");
    };
    r.onend = () => {
      opts.onInterim?.("");
      const heard = finalText.trim();
      teardown();
      if (heard) {
        // Mic is already released here; the consumer transitions to its own
        // "thinking" state and TTS plays with zero live mic owners.
        opts.onFinal?.(heard);
      } else {
        opts.onStateChange?.("idle");
      }
    };

    // Take the lease up front so the registry mirrors the hardware from the
    // instant capture is requested.
    lease = acquireMic(tag);
    listening = true;
    opts.onStateChange?.("listening");
    try {
      r.start();
      rec = r;
    } catch {
      teardown();
      opts.onStateChange?.("idle");
      return;
    }

    // Idle backstop: an open mic nobody is speaking into gets stopped. If the
    // browser then fails to fire onend, the watchdog force-tears-down anyway.
    idleTimer = setTimer(() => {
      const current = rec;
      if (!current) return;
      try {
        current.stop();
      } catch {
        teardown();
        opts.onStateChange?.("idle");
        return;
      }
      watchdog = setTimer(() => {
        if (rec) {
          teardown();
          opts.onStateChange?.("idle");
        }
      }, watchdogMs);
    }, idleMs);
  }

  function stop() {
    if (!listening) return;
    const r = rec;
    if (!r) {
      teardown();
      opts.onStateChange?.("idle");
      return;
    }
    // Graceful: deliver what was heard via onend. Arm a watchdog so a swallowed
    // onend can't strand the mic.
    try {
      r.stop();
    } catch {
      teardown();
      opts.onStateChange?.("idle");
      return;
    }
    if (watchdog == null) {
      watchdog = setTimer(() => {
        if (rec) {
          teardown();
          opts.onStateChange?.("idle");
        }
      }, watchdogMs);
    }
  }

  function cancel(_reason?: string) {
    if (!listening && rec == null && lease == null) return;
    teardown();
    opts.onStateChange?.("idle");
  }

  // Emergency stop from the Pause pill / pagehide / tab-hidden. Unconditional.
  const unsubscribe = onMicPanic((reason) => cancel(reason));

  function dispose() {
    unsubscribe();
    if (listening || rec != null || lease != null) teardown();
  }

  return {
    start,
    stop,
    cancel,
    dispose,
    get listening() {
      return listening;
    },
  };
}
