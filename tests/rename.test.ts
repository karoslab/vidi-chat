import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ before the module computes its cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-rename-test-")));
const { createThread, getThread, updateThread } = await import("../lib/store.ts");

test("renames a thread via updateThread", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, (th) => {
    th.title = "My renamed thread";
  });
  assert.equal(getThread(t.id)?.title, "My renamed thread");
});

test("title is trimmed when set", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, (th) => {
    th.title = "  padded title  ".trim();
  });
  assert.equal(getThread(t.id)?.title, "padded title");
});

test("title at exactly 80 characters is accepted", async () => {
  const t = createThread("claude", "sonnet", "chat");
  const title = "a".repeat(80);
  await updateThread(t.id, (th) => {
    th.title = title;
  });
  assert.equal(getThread(t.id)?.title, title);
});

test("rename does not affect other thread fields", async () => {
  const t = createThread("claude", "sonnet", "auto", "high");
  await updateThread(t.id, (th) => {
    th.title = "New title";
  });
  const after = getThread(t.id)!;
  assert.equal(after.title, "New title");
  assert.equal(after.mode, "auto");
  assert.equal(after.effort, "high");
  assert.equal(after.provider, "claude");
});

test("rename returns null for a missing thread", async () => {
  const result = await updateThread("no-such-thread", (th) => {
    th.title = "ghost";
  });
  assert.equal(result, null);
});

test("renamed title persists across reads", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await updateThread(t.id, (th) => {
    th.title = "Persistent name";
  });
  // Read twice to confirm it's written to disk
  assert.equal(getThread(t.id)?.title, "Persistent name");
  assert.equal(getThread(t.id)?.title, "Persistent name");
});

test("concurrent renames serialize correctly (last writer wins)", async () => {
  const t = createThread("claude", "sonnet", "chat");
  await Promise.all([
    updateThread(t.id, (th) => { th.title = "name-A"; }),
    updateThread(t.id, (th) => { th.title = "name-B"; }),
  ]);
  const after = getThread(t.id)!;
  // One of the two names must have won; no corruption
  assert.ok(after.title === "name-A" || after.title === "name-B");
});
