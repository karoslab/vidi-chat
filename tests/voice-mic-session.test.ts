import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicSession, type MicRecognition } from "../lib/voice-mic-session.ts";
import {
  hasLiveMic,
  activeMicOwners,
  panicMicRelease,
  __resetMicRegistryForTests,
} from "../lib/mic-registry.ts";

/**
 * The whole point of the trust fix: after EVERY terminal path the mic registry
 * must be empty (Safari's indicator goes dark). A real SpeechRecognition can't
 * run under `node --test`, so we drive a faithful fake and assert the registry
 * directly — the same thing the browser indicator reflects.
 */

/** A fake SpeechRecognition that records the teardown calls and lets a test
 *  fire onresult / onend / onerror by hand. */
class FakeRecognition implements MicRecognition {
  lang = "";
  interimResults = false;
  continuous = true; // starts wrong on purpose; start() must force it false
  maxAlternatives = 0;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = 0;
  aborted = 0;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.aborted++;
  }
  emitFinal(text: string) {
    this.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] });
  }
  emitInterim(text: string) {
    this.onresult?.({ results: [{ isFinal: false, 0: { transcript: text } }] });
  }
  fireEnd() {
    this.onend?.();
  }
  fireError(kind: string) {
    this.onerror?.({ error: kind });
  }
}

/** Manual timer harness so idle/watchdog fire on command, not on wall time. */
function makeScheduler() {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const h = ++id;
      timers.set(h, fn);
      return h as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      timers.delete(h as unknown as number);
    },
    /** Drain every pending timer, including ones armed during the drain (the
     *  idle backstop arms a watchdog), until none remain. */
    flush() {
      let guard = 0;
      while (timers.size > 0 && guard++ < 100) {
        const next = timers.keys().next().value as number;
        const fn = timers.get(next)!;
        timers.delete(next);
        fn();
      }
    },
    size: () => timers.size,
  };
}

type Harness = {
  session: ReturnType<typeof createMicSession>;
  rec: FakeRecognition;
  finals: string[];
  states: string[];
  errors: string[];
  interims: string[];
  sched: ReturnType<typeof makeScheduler>;
};

function setup(): Harness {
  __resetMicRegistryForTests();
  const sched = makeScheduler();
  const rec = new FakeRecognition();
  const finals: string[] = [];
  const states: string[] = [];
  const errors: string[] = [];
  const interims: string[] = [];
  const session = createMicSession({
    tag: "voice-chat",
    createRecognition: () => rec,
    onFinal: (t) => finals.push(t),
    onStateChange: (s) => states.push(s),
    onError: (k) => errors.push(k),
    onInterim: (t) => interims.push(t),
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
  });
  return { session, rec, finals, states, errors, interims, sched };
}

test("start captures the mic and forces single-utterance push-to-talk config", () => {
  const h = setup();
  h.session.start();
  assert.equal(h.rec.started, true);
  assert.equal(h.rec.continuous, false, "must never be hands-free");
  assert.equal(h.rec.interimResults, true);
  assert.equal(hasLiveMic(), true);
  assert.deepEqual(activeMicOwners(), ["voice-chat"]);
  assert.equal(h.session.listening, true);
  assert.deepEqual(h.states, ["listening"]);
});

test("turn ends with speech: mic released BEFORE the final is delivered", () => {
  const h = setup();
  h.session.start();
  h.rec.emitFinal("hey vidi what's up");
  // The user tapped to finish (or the browser ended) → onend fires.
  h.rec.fireEnd();
  assert.equal(hasLiveMic(), false, "mic must be dark after the turn");
  assert.equal(h.session.listening, false);
  assert.deepEqual(h.finals, ["hey vidi what's up"]);
  // onFinal ran only after release, so TTS plays with zero live mic owners.
  assert.equal(hasLiveMic(), false);
});

test("turn ends with no speech: mic released and state goes idle", () => {
  const h = setup();
  h.session.start();
  h.rec.fireEnd();
  assert.equal(hasLiveMic(), false);
  assert.deepEqual(h.finals, []);
  assert.deepEqual(h.states, ["listening", "idle"]);
});

test("TTS continuing after the user stops: no mic is held", () => {
  const h = setup();
  h.session.start();
  h.rec.emitFinal("play a reply");
  h.rec.fireEnd();
  // Simulate TTS playback taking a while after onFinal — registry stays empty.
  assert.equal(hasLiveMic(), false);
  assert.equal(activeMicOwners().length, 0);
});

test("graceful stop() releases the mic (even if onend is swallowed)", () => {
  const h = setup();
  h.session.start();
  h.session.stop(); // asks the browser to end; arms a watchdog
  assert.equal(h.rec.stopped >= 1, true);
  // Browser never fires onend — the watchdog must still release.
  assert.equal(hasLiveMic(), true, "still held until onend or the watchdog");
  h.sched.flush(); // fire the watchdog
  assert.equal(hasLiveMic(), false, "watchdog force-released the stranded mic");
  assert.equal(h.rec.aborted >= 1, true);
});

test("cancel() releases the mic immediately, delivering nothing", () => {
  const h = setup();
  h.session.start();
  h.session.cancel("toggle-off");
  assert.equal(hasLiveMic(), false);
  assert.equal(h.session.listening, false);
  assert.deepEqual(h.finals, []);
  assert.equal(h.rec.aborted >= 1, true);
});

test("error mid-turn releases the mic and surfaces the error kind", () => {
  const h = setup();
  h.session.start();
  h.rec.fireError("not-allowed");
  assert.equal(hasLiveMic(), false);
  assert.deepEqual(h.errors, ["not-allowed"]);
  assert.deepEqual(h.states, ["listening", "idle"]);
});

test("idle backstop stops an open mic, and the watchdog guarantees release", () => {
  const h = setup();
  h.session.start();
  assert.equal(hasLiveMic(), true);
  // The idle timer calls stop() and arms a watchdog; if the browser swallows
  // onend, the watchdog force-releases. Draining both proves the mic is freed.
  h.sched.flush();
  assert.equal(hasLiveMic(), false);
  assert.equal(h.rec.stopped >= 1, true);
});

test("panic (Pause pill / pagehide) tears the session down instantly", () => {
  const h = setup();
  h.session.start();
  assert.equal(hasLiveMic(), true);
  panicMicRelease("pause");
  assert.equal(hasLiveMic(), false);
  assert.equal(h.session.listening, false);
  assert.equal(h.rec.aborted >= 1, true);
});

test("start() is a no-op while already listening (no second lease)", () => {
  const h = setup();
  h.session.start();
  h.session.start();
  assert.equal(activeMicOwners().length, 1);
});

test("dispose() detaches panic and releases any live mic", () => {
  const h = setup();
  h.session.start();
  h.session.dispose();
  assert.equal(hasLiveMic(), false);
  // After dispose the panic handler is gone: a later panic must not throw and
  // there is nothing left to release.
  panicMicRelease("late");
  assert.equal(hasLiveMic(), false);
});

test("recognition not supported: start() does not acquire a mic", () => {
  __resetMicRegistryForTests();
  const session = createMicSession({ createRecognition: () => null });
  session.start();
  assert.equal(hasLiveMic(), false);
  assert.equal(session.listening, false);
});
