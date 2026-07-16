import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFingerprint,
  fingerprintsMatch,
  shouldResumeSession,
} from "../lib/session-fingerprint.ts";

/**
 * FIX 1 — mid-thread provider/model/effort/mode switching. A CLI session is
 * pinned to what it was created with; the fingerprint gate decides whether the
 * next turn may --resume (settings unchanged) or must start a fresh session (a
 * switch, so the change actually takes effect).
 */

test("computeFingerprint normalizes effort + mode, coerces missing model to null", () => {
  assert.deepEqual(
    computeFingerprint({ provider: "claude", model: "opus", effort: undefined, mode: "act" }),
    { provider: "claude", model: "opus", effort: "medium", mode: "auto" }
  );
  assert.equal(computeFingerprint({ provider: "grok" }).model, null);
});

test("no stored session id → never resume", () => {
  assert.equal(
    shouldResumeSession({
      priorProviderSessionId: null,
      storedFingerprint: null,
      current: computeFingerprint({ provider: "claude" }),
    }),
    false
  );
});

test("legacy session with no fingerprint resumes (preserves continuity)", () => {
  assert.equal(
    shouldResumeSession({
      priorProviderSessionId: "sess-1",
      storedFingerprint: undefined,
      current: computeFingerprint({ provider: "claude", model: "opus" }),
    }),
    true
  );
});

test("identical settings resume; a delta on ANY axis forces a fresh session", () => {
  const base = computeFingerprint({
    provider: "claude",
    model: "opus",
    effort: "high",
    mode: "plan",
  });
  const resume = (current: ReturnType<typeof computeFingerprint>) =>
    shouldResumeSession({ priorProviderSessionId: "s", storedFingerprint: base, current });

  assert.equal(resume(base), true); // unchanged → resume

  assert.equal(
    resume(computeFingerprint({ provider: "claude", model: "sonnet", effort: "high", mode: "plan" })),
    false,
    "model change → fresh"
  );
  assert.equal(
    resume(computeFingerprint({ provider: "codex", model: "opus", effort: "high", mode: "plan" })),
    false,
    "provider change → fresh"
  );
  assert.equal(
    resume(computeFingerprint({ provider: "claude", model: "opus", effort: "high", mode: "auto" })),
    false,
    "mode change → fresh"
  );
});

test("an effort delta ALONE (same provider/model/mode) forces a fresh session (FIX 6 seamless switch)", () => {
  const before = computeFingerprint({ provider: "claude", model: "opus", effort: "medium", mode: "plan" });
  const after = computeFingerprint({ provider: "claude", model: "opus", effort: "ultra", mode: "plan" });
  assert.equal(fingerprintsMatch(before, after), false);
  assert.equal(
    shouldResumeSession({ priorProviderSessionId: "s", storedFingerprint: before, current: after }),
    false
  );
});

test("grok Chat↔Build (same underlying model) changes the fingerprint → fresh session (FIX 3)", () => {
  const build = computeFingerprint({ provider: "grok", model: "grok-4.5-build", effort: "medium", mode: "plan" });
  const chat = computeFingerprint({ provider: "grok", model: "grok-4.5-chat", effort: "medium", mode: "plan" });
  assert.equal(fingerprintsMatch(build, chat), false);
  assert.equal(
    shouldResumeSession({ priorProviderSessionId: "s", storedFingerprint: build, current: chat }),
    false
  );
});

/**
 * Regression: stamp the PRE-SEND snapshot, not a recompute at done-time
 * (QA finding on PR #50 — app/api/chat/route.ts, lib/voice-turn.ts,
 * lib/goals.ts all recomputed `computeFingerprint(th)` from the thread object
 * AT DONE TIME instead of persisting the already-computed pre-send snapshot).
 *
 * The race: a settings PATCH (a separate withThreadLock) can land after the
 * session was actually spawned (with the OLD settings) but before the done
 * event stamps the fingerprint. Recomputing from the thread at that point bakes
 * in the NEW (PATCHed) settings — even though the live provider session still
 * embodies the OLD ones. The next turn then computes the same NEW settings as
 * "current", matches the (wrongly-stamped) fingerprint, and resumes a session
 * that never actually adopted the switch — silently swallowing it.
 *
 * Stamping the pre-send snapshot instead means the fingerprint always reflects
 * what the session was ACTUALLY born with, so the next turn's mismatch against
 * the real (new) settings is still detected and forces the fresh session the
 * PATCH was supposed to trigger.
 */
test("stamping the pre-send snapshot (not a done-time recompute) survives a mid-turn settings PATCH race", () => {
  // Turn 1 starts: this is what the session is actually spawned with.
  const preSendSnapshot = computeFingerprint({
    provider: "claude",
    model: "sonnet",
    effort: "medium",
    mode: "plan",
  });

  // A concurrent PATCH lands after send but before done — the thread object
  // now reflects the NEW settings the user actually asked for.
  const threadAfterConcurrentPatch = {
    provider: "claude",
    model: "opus",
    effort: "high",
    mode: "plan",
  };

  // CORRECT: stamp the pre-send snapshot (what manager.ts does, and what the
  // three fixed call sites now do too).
  const correctStamp = preSendSnapshot;
  // BUGGY (the defect being regressed against): recompute from the thread at
  // done-time, which has already absorbed the concurrent PATCH.
  const buggyStamp = computeFingerprint(threadAfterConcurrentPatch);
  assert.notDeepEqual(correctStamp, buggyStamp, "the race must actually produce a divergent stamp");

  // Turn 2 starts: the thread's settings are (still) the PATCHed ones.
  const turn2Current = computeFingerprint(threadAfterConcurrentPatch);

  // With the correct stamp, turn 2's real settings no longer match what the
  // session was born with → must NOT resume → the switch takes effect.
  assert.equal(
    shouldResumeSession({
      priorProviderSessionId: "sess-1",
      storedFingerprint: correctStamp,
      current: turn2Current,
    }),
    false,
    "correct stamp must force a fresh session so the PATCHed switch actually applies"
  );

  // With the buggy stamp, turn 2 wrongly matches and resumes — the switch is
  // silently swallowed (this is the regression this test guards against).
  assert.equal(
    shouldResumeSession({
      priorProviderSessionId: "sess-1",
      storedFingerprint: buggyStamp,
      current: turn2Current,
    }),
    true,
    "demonstrates the bug: recompute-at-done-time wrongly matches and resumes"
  );
});
