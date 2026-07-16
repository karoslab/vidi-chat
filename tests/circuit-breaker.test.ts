import { test } from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker } from "../lib/circuit-breaker.ts";
import { withBreaker, breakerFor } from "../lib/providers/index.ts";
import type {
  BrainProvider,
  ProviderStreamEvent,
} from "../lib/providers/types.ts";

/**
 * Provider circuit breaker (lib/circuit-breaker.ts). All timing is driven by an
 * injectable clock so the tests are deterministic — never a real wall clock.
 */

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test("closed breaker allows requests and stays closed on success", () => {
  const b = new CircuitBreaker({ minSamples: 3, threshold: 0.5, now: () => 0 });
  assert.equal(b.state, "closed");
  for (let i = 0; i < 5; i++) {
    assert.equal(b.allow(), true);
    b.recordSuccess();
  }
  assert.equal(b.state, "closed");
});

test("does not trip below minSamples even when every result fails", () => {
  const b = new CircuitBreaker({ minSamples: 5, threshold: 0.5, now: () => 0 });
  for (let i = 0; i < 4; i++) b.recordFailure();
  assert.equal(b.state, "closed");
  assert.equal(b.allow(), true);
});

test("trips open once minSamples reached and failure rate meets threshold", () => {
  // 3 successes + 3 failures = 6 samples, rate 0.5 == threshold → open.
  const b = new CircuitBreaker({ minSamples: 5, threshold: 0.5, now: () => 0 });
  for (let i = 0; i < 3; i++) b.recordSuccess();
  assert.equal(b.state, "closed");
  for (let i = 0; i < 3; i++) b.recordFailure();
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false);
});

test("open breaker fails fast until cooldown, then admits one half-open probe", () => {
  const clock = fakeClock();
  const b = new CircuitBreaker({
    minSamples: 3,
    threshold: 0.5,
    cooldownMs: 1000,
    now: clock.now,
  });
  for (let i = 0; i < 3; i++) b.recordFailure();
  assert.equal(b.state, "open");

  clock.advance(999);
  assert.equal(b.allow(), false, "still open just before cooldown elapses");

  clock.advance(1);
  assert.equal(b.allow(), true, "cooldown elapsed → probe admitted");
  assert.equal(b.state, "half-open");
  assert.equal(b.allow(), false, "only one probe in flight at a time");
});

test("a successful half-open probe closes the breaker and clears the window", () => {
  const clock = fakeClock();
  const b = new CircuitBreaker({
    minSamples: 3,
    threshold: 0.5,
    cooldownMs: 1000,
    now: clock.now,
  });
  for (let i = 0; i < 3; i++) b.recordFailure();
  clock.advance(1000);
  assert.equal(b.allow(), true);
  b.recordSuccess();
  assert.equal(b.state, "closed");
  // Window was reset: a single fresh failure is well below minSamples again.
  b.recordFailure();
  assert.equal(b.state, "closed");
});

test("a failed half-open probe re-opens the breaker for another cooldown", () => {
  const clock = fakeClock();
  const b = new CircuitBreaker({
    minSamples: 3,
    threshold: 0.5,
    cooldownMs: 1000,
    now: clock.now,
  });
  for (let i = 0; i < 3; i++) b.recordFailure();
  clock.advance(1000);
  assert.equal(b.allow(), true);
  b.recordFailure();
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false, "re-opened → fails fast again");
  clock.advance(1000);
  assert.equal(b.allow(), true, "next cooldown admits another probe");
});

test("old results roll off the sliding window", () => {
  // window 3, trips only on an all-failure window. Recording F,S,F,F leaves the
  // window at [S,F,F] (rate 2/3) because the FIRST failure was evicted — proof
  // the oldest sample rolled off rather than counting toward the rate.
  const b = new CircuitBreaker({
    windowSize: 3,
    minSamples: 3,
    threshold: 1,
    now: () => 0,
  });
  b.recordFailure();
  b.recordSuccess();
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.state, "closed");
});

/** A minimal fake provider that records whether it was ever spawned. */
function fakeProvider(id: string): BrainProvider & { spawned: boolean } {
  const p = {
    id,
    label: `Fake ${id}`,
    models: [],
    spawned: false,
    async available() {
      return { ok: true };
    },
    async *sendMessage(): AsyncGenerator<ProviderStreamEvent> {
      p.spawned = true;
      yield { type: "done", providerSessionId: null, fullText: "hi" };
    },
  };
  return p;
}

test("withBreaker fails fast (never spawns) once its provider's breaker is open", async () => {
  const id = "fake-wedged";
  // Drive this provider's shared breaker open via its public record surface.
  const breaker = breakerFor(id);
  for (let i = 0; i < 6; i++) breaker.recordFailure();
  assert.equal(breaker.state, "open");

  const provider = fakeProvider(id);
  const events: ProviderStreamEvent[] = [];
  for await (const ev of withBreaker(provider).sendMessage({
    threadId: "t1",
    userMessage: "hello",
  })) {
    events.push(ev);
  }

  assert.equal(provider.spawned, false, "doomed session must not be spawned");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
});

test("withBreaker passes turns through and feeds success back to the breaker", async () => {
  const id = "fake-healthy";
  const provider = fakeProvider(id);
  const events: ProviderStreamEvent[] = [];
  for await (const ev of withBreaker(provider).sendMessage({
    threadId: "t1",
    userMessage: "hello",
  })) {
    events.push(ev);
  }

  assert.equal(provider.spawned, true);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(breakerFor(id).state, "closed");
});

/** A provider whose sendMessage yields an error event then a done. */
function erroringProvider(id: string): BrainProvider {
  return {
    id,
    label: `Fake ${id}`,
    models: [],
    async available() {
      return { ok: true };
    },
    async *sendMessage(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: "error", message: "boom" };
      yield { type: "done", providerSessionId: null, fullText: "" };
    },
  };
}

test("withBreaker settles the breaker when the consumer abandons the generator on an error event", async () => {
  // Mirrors lib/memory-wiki.ts: throw out of the consumer loop on an error
  // event. The runtime .return()s the wrapper at the suspended yield, so only a
  // finally can settle the breaker. Regression guard: the failure must still be
  // counted rather than silently lost.
  const id = "fake-abandoned";
  const breaker = breakerFor(id);
  await assert.rejects(async () => {
    for await (const ev of withBreaker(erroringProvider(id)).sendMessage({
      threadId: "t1",
      userMessage: "hi",
    })) {
      if (ev.type === "error") throw new Error(ev.message);
    }
  }, /boom/);
  // The abandoned turn was recorded as a failure (one sample in the window).
  // Below minSamples so still closed, but the sample proves settle() ran.
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  // 5 failures total (1 from teardown + 4 here) → trips at the default minSamples.
  assert.equal(breaker.state, "open");
});
