import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ before the module computes its cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-store-test-")));
const {
  createThread,
  getThread,
  saveThread,
  updateThread,
  withThreadLock,
  withTurnLock,
  searchThreads,
} = await import("../lib/store.ts");

test("updateThread survives concurrent mutations (no lost updates)", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      updateThread(t.id, (th) => {
        th.messages.push({ role: "user", text: `msg-${i}`, ts: Date.now() });
      })
    )
  );
  const after = getThread(t.id);
  assert.equal(after?.messages.length, 10);
});

test("updateThread waits for an in-flight lock holder (fails without the lock)", async () => {
  // The route pattern: a holder reads, yields the event loop, writes. If
  // updateThread did NOT take the same lock, it would save during the
  // holder's sleep and the holder's stale save would clobber it (length 1).
  const t = createThread("claude", "sonnet", "chat");
  const holder = withThreadLock(t.id, async () => {
    const th = getThread(t.id)!;
    await new Promise((r) => setTimeout(r, 30));
    th.messages.push({ role: "assistant", text: "holder", ts: Date.now() });
    saveThread(th);
  });
  await new Promise((r) => setTimeout(r, 5)); // holder is mid-sleep
  const racer = updateThread(t.id, (th) => {
    th.messages.push({ role: "user", text: "racer", ts: Date.now() });
  });
  await Promise.all([holder, racer]);
  const after = getThread(t.id);
  assert.deepEqual(
    after?.messages.map((m) => m.text).sort(),
    ["holder", "racer"]
  );
});

test("updateThread awaits async mutators", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, async (th) => {
    await new Promise((r) => setTimeout(r, 10));
    th.messages.push({ role: "user", text: "async", ts: Date.now() });
  });
  assert.equal(getThread(t.id)?.messages.length, 1);
});

test("turn lock and thread lock are separate tables (no deadlock)", async () => {
  const t = createThread("claude", "sonnet", "chat");
  // A turn holds the turn lock and calls updateThread inside — must not hang.
  await withTurnLock(t.id, async () => {
    await updateThread(t.id, (th) => {
      th.messages.push({ role: "user", text: "inner", ts: Date.now() });
    });
  });
  assert.equal(getThread(t.id)?.messages.length, 1);
});

test("withThreadLock serializes async read-modify-write races", async () => {
  const t = createThread("claude", "sonnet", "chat");
  // Each task reads, yields the event loop (the await a real turn does),
  // then writes — the exact interleaving that lost updates without the lock.
  const racyAppend = (text: string) =>
    withThreadLock(t.id, async () => {
      const th = getThread(t.id)!;
      await new Promise((r) => setTimeout(r, 10));
      th.messages.push({ role: "assistant", text, ts: Date.now() });
      const { saveThread } = await import("../lib/store.ts");
      saveThread(th);
    });
  await Promise.all([racyAppend("a"), racyAppend("b"), racyAppend("c")]);
  const after = getThread(t.id);
  assert.deepEqual(
    after?.messages.map((m) => m.text).sort(),
    ["a", "b", "c"]
  );
});

test("updateThread returns null for a missing thread", async () => {
  assert.equal(await updateThread("no-such-thread", () => {}), null);
});

test("searchThreads matches title case-insensitively", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, (th) => { th.title = "My Unique ZZZ Title"; });
  const results = searchThreads("unique zzz");
  assert.ok(results.some((r) => r.id === t.id));
  assert.ok(results.every((r) => !("messages" in r)));
});

test("searchThreads matches message text case-insensitively", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, (th) => {
    th.messages.push({ role: "user", text: "QQQ distinctive message QQQ", ts: Date.now() });
  });
  const results = searchThreads("QQQ DISTINCTIVE");
  assert.ok(results.some((r) => r.id === t.id));
});

test("searchThreads returns empty array when nothing matches", async () => {
  const results = searchThreads("XYZZY_NO_MATCH_999");
  assert.deepEqual(results, []);
});

test("locks on different threads do not serialize each other", async () => {
  const a = createThread("claude", null, "chat");
  const b = createThread("claude", null, "chat");
  const order: string[] = [];
  await Promise.all([
    withThreadLock(a.id, async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    }),
    withThreadLock(b.id, async () => {
      order.push("b");
    }),
  ]);
  // b must not have waited for a's 30ms hold.
  assert.deepEqual(order, ["b", "a"]);
});
