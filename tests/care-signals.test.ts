import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCareSignals,
  renderCareSignals,
  SESSION_GAP_MS,
} from "../lib/care-signals.ts";
import type { ChatMessage } from "../lib/store.ts";

/** A user/assistant message at an offset (ms) before `base`. */
function msg(role: "user" | "assistant", text: string, ts: number): ChatMessage {
  return { role, text, ts };
}

/** A Date pinned to a specific local hour today (for isLate / localHour). */
function atLocalHour(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

test("empty thread → all quiet: no session time, no return, no retries", () => {
  const s = computeCareSignals([], { now: atLocalHour(14), currentUserText: "hey" });
  assert.equal(s.minutesInSession, 0);
  assert.equal(s.returningAfterGap, false);
  assert.equal(s.recentRetryCount, 1); // the one in-flight ask, no repeat
  assert.equal(s.isLate, false);
  assert.equal(s.localHour, 14);
});

test("isLate flags the small hours and only the small hours", () => {
  assert.equal(computeCareSignals([], { now: atLocalHour(23) }).isLate, true);
  assert.equal(computeCareSignals([], { now: atLocalHour(2) }).isLate, true);
  assert.equal(computeCareSignals([], { now: atLocalHour(4) }).isLate, true);
  assert.equal(computeCareSignals([], { now: atLocalHour(5) }).isLate, false);
  assert.equal(computeCareSignals([], { now: atLocalHour(12) }).isLate, false);
  assert.equal(computeCareSignals([], { now: atLocalHour(22) }).isLate, false);
});

test("minutesInSession spans a continuous run of turns", () => {
  const now = new Date("2026-07-05T22:00:00");
  const nowMs = now.getTime();
  const messages = [
    msg("user", "start", nowMs - 100 * 60000),
    msg("assistant", "ok", nowMs - 99 * 60000),
    // steps stay under SESSION_GAP_MS (45min) so it's one continuous sitting
    msg("user", "more", nowMs - 65 * 60000),
    msg("assistant", "sure", nowMs - 64 * 60000),
    msg("user", "keep going", nowMs - 30 * 60000),
    msg("assistant", "yep", nowMs - 29 * 60000),
  ];
  const s = computeCareSignals(messages, { now });
  assert.equal(s.minutesInSession, 100);
  assert.equal(s.returningAfterGap, false);
});

test("a gap breaks the sitting: this turn opens a fresh one (return flagged)", () => {
  const now = new Date("2026-07-05T22:00:00");
  const nowMs = now.getTime();
  const messages = [
    msg("user", "earlier", nowMs - 5 * 60 * 60000), // 5h ago
    msg("assistant", "reply", nowMs - 5 * 60 * 60000 + 1000),
  ];
  const s = computeCareSignals(messages, { now });
  assert.equal(s.returningAfterGap, true);
  assert.equal(s.minutesInSession, 0, "a fresh sitting has no elapsed time yet");
});

test("sitting start walks back only through sub-gap steps", () => {
  const now = new Date("2026-07-05T22:00:00");
  const nowMs = now.getTime();
  const gapMin = SESSION_GAP_MS / 60000;
  const messages = [
    msg("user", "long ago", nowMs - 300 * 60000),
    // gap larger than SESSION_GAP_MS here
    msg("user", "this sitting a", nowMs - 30 * 60000),
    msg("assistant", "b", nowMs - 29 * 60000),
    msg("user", "this sitting c", nowMs - (gapMin - 5) * 60000),
  ];
  const s = computeCareSignals(messages, { now });
  // The sitting starts at the -30min turn, not the -300min one.
  assert.equal(s.minutesInSession, 30);
});

test("recentRetryCount climbs on near-identical consecutive asks", () => {
  const now = new Date("2026-07-05T22:00:00");
  const nowMs = now.getTime();
  const messages = [
    msg("user", "why does the login test keep failing", nowMs - 6 * 60000),
    msg("assistant", "let me look", nowMs - 5 * 60000),
    msg("user", "the login test is still failing why", nowMs - 3 * 60000),
    msg("assistant", "trying again", nowMs - 2 * 60000),
  ];
  const s = computeCareSignals(messages, {
    now,
    currentUserText: "login test failing again, why",
  });
  assert.equal(s.recentRetryCount, 3);
});

test("recentRetryCount stays 1 when the topic changes", () => {
  const now = new Date("2026-07-05T22:00:00");
  const nowMs = now.getTime();
  const messages = [
    msg("user", "what's on my calendar tomorrow", nowMs - 3 * 60000),
    msg("assistant", "two meetings", nowMs - 2 * 60000),
  ];
  const s = computeCareSignals(messages, {
    now,
    currentUserText: "draft a reply to my landlord about the leak",
  });
  assert.equal(s.recentRetryCount, 1);
});

test("renderCareSignals returns null when nothing is worth surfacing", () => {
  const s = computeCareSignals([], { now: atLocalHour(14), currentUserText: "hi there friend" });
  assert.equal(renderCareSignals(s), null);
});

test("renderCareSignals surfaces late + retries, labeled and hedged", () => {
  const now = atLocalHour(1);
  const nowMs = now.getTime();
  const messages = [
    msg("user", "build test broken same error still", nowMs - 6 * 60000),
    msg("assistant", "hmm", nowMs - 5 * 60000),
    msg("user", "build test broken still same error", nowMs - 4 * 60000),
    msg("assistant", "retrying", nowMs - 3 * 60000),
  ];
  const s = computeCareSignals(messages, {
    now,
    currentUserText: "build test broken still same error again",
  });
  const rendered = renderCareSignals(s);
  assert.ok(rendered, "should render something at 1am with a retry");
  assert.match(rendered!, /1am \(late\)/);
  assert.match(rendered!, /in a row/);
  // The hedge is load-bearing — it must tell the model to act rarely.
  assert.match(rendered!, /RARELY/);
  // No hardcoded advice or phrasing leaks into the block.
  assert.doesNotMatch(rendered!, /you should|go to bed|take a break/i);
});

test("renderCareSignals surfaces a long sitting rounded to 15-min steps", () => {
  const now = new Date("2026-07-05T20:00:00");
  const nowMs = now.getTime();
  // A continuous 130-min haul: each step stays under the 45-min gap.
  const messages = [
    msg("user", "start of a long haul", nowMs - 130 * 60000),
    msg("assistant", "ok", nowMs - 129 * 60000),
    msg("user", "middle", nowMs - 90 * 60000),
    msg("assistant", "still here", nowMs - 89 * 60000),
    msg("user", "later", nowMs - 50 * 60000),
    msg("assistant", "yep", nowMs - 49 * 60000),
    msg("user", "recent", nowMs - 10 * 60000),
    msg("assistant", "ok", nowMs - 9 * 60000),
  ];
  const s = computeCareSignals(messages, { now, currentUserText: "next thing please" });
  const rendered = renderCareSignals(s);
  assert.ok(rendered);
  assert.match(rendered!, /this sitting has run ~\d+ min/);
});
