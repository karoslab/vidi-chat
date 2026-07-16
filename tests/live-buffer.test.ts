import { test } from "node:test";
import assert from "node:assert/strict";

const { appendLive, getLive, clearLive } = await import("../lib/live-buffer.ts");

test("appendLive creates then accumulates a buffer", () => {
  const id = "buf-accumulate";
  assert.equal(getLive(id), null, "no buffer before first write");

  appendLive(id, "Hello");
  const first = getLive(id)!;
  assert.equal(first.text, "Hello");
  assert.equal(typeof first.startedAt, "number");
  assert.equal(first.startedAt, first.updatedAt);

  appendLive(id, ", world");
  const second = getLive(id)!;
  assert.equal(second.text, "Hello, world");
  assert.equal(second.startedAt, first.startedAt, "startedAt is stable across writes");
  assert.ok(second.updatedAt >= first.updatedAt, "updatedAt advances");

  clearLive(id);
});

test("appendLive ignores empty chunks (no phantom buffer)", () => {
  const id = "buf-empty";
  appendLive(id, "");
  assert.equal(getLive(id), null, "empty first write must not create a buffer");

  appendLive(id, "x");
  appendLive(id, "");
  assert.equal(getLive(id)!.text, "x", "empty write on an existing buffer is a no-op");

  clearLive(id);
});

test("clearLive drops the buffer so getLive returns null", () => {
  const id = "buf-clear";
  appendLive(id, "in flight");
  assert.equal(getLive(id)!.text, "in flight");

  clearLive(id);
  assert.equal(getLive(id), null, "cleared buffer reads as null (turn ended)");

  // Clearing an absent buffer is safe (idempotent finally in the provider).
  assert.doesNotThrow(() => clearLive(id));
});

test("buffers are keyed independently per thread", () => {
  appendLive("thread-a", "aaa");
  appendLive("thread-b", "bbb");
  assert.equal(getLive("thread-a")!.text, "aaa");
  assert.equal(getLive("thread-b")!.text, "bbb");

  clearLive("thread-a");
  assert.equal(getLive("thread-a"), null);
  assert.equal(getLive("thread-b")!.text, "bbb", "clearing one thread leaves the other");

  clearLive("thread-b");
});
