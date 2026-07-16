import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// These suites model the OWNER install (owner-default identity in prompts
// and brain paths). The customer identity contract is pinned in user-config.test.ts.
process.env.VIDI_OWNER = "1";


// Isolate data/ before lib/store computes its cwd-based paths (recent.ts
// reads threads through the store).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-recent-test-")));
const { gatherRecentSources, pickRelevantSnippets, recentBuffer } = await import(
  "../lib/recent.ts"
);
const { createThread, saveThread, updateThread } = await import("../lib/store.ts");
// The speaker label the source prepends is the resolved displayName; on the owner
// install that is the built-in default, sourced here rather than restated.
const { DEFAULT_USER_CONFIG } = await import("../lib/user-config.ts");

function makeTempNotesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vidi-recent-notes-"));
}

test("pickRelevantSnippets ranks by word overlap and drops zero-score sources", () => {
  const now = Date.now();
  const picked = pickRelevantSnippets(
    "what did I say about the demo password",
    [
      { label: "note", ts: now - 1000, text: "the demo password is in 1Password under demo" },
      { label: "voice", ts: now - 2000, text: "Sam: play some music" },
      { label: "voice", ts: now - 500, text: "Sam: the demo is on friday" },
    ]
  );
  assert.ok(picked);
  const lines = picked!.split("\n");
  // The note matches "demo" + "password" (2 words) and must outrank the
  // single-word "demo" match; the music line matches nothing and is dropped.
  assert.match(lines[0], /1Password/);
  assert.ok(!picked!.includes("music"));
});

test("pickRelevantSnippets returns null when nothing matches", () => {
  const picked = pickRelevantSnippets("completely unrelated query", [
    { label: "note", ts: Date.now(), text: "the wifi runs on the attic router" },
  ]);
  assert.equal(picked, null);
});

test("snippets are clipped to one line and ~300 chars", () => {
  const longText = "demo " + "x".repeat(500) + "\nsecond line";
  const picked = pickRelevantSnippets("about the demo", [
    { label: "note", ts: Date.now(), text: longText },
  ]);
  assert.ok(picked);
  assert.ok(!picked!.includes("\nsecond"), "newlines collapsed");
  assert.ok(picked!.length < 320, `too long: ${picked!.length}`);
});

test("gatherRecentSources picks up fresh notes and skips stale ones", () => {
  const notesDir = makeTempNotesDir();
  fs.writeFileSync(path.join(notesDir, "fresh.md"), "the demo password is hunter2");
  const stalePath = path.join(notesDir, "stale.md");
  fs.writeFileSync(stalePath, "ancient forgotten fact");
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stalePath, threeDaysAgo, threeDaysAgo);

  const sources = gatherRecentSources({ notesDir });
  const texts = sources.map((s) => s.text);
  assert.ok(texts.some((t) => t.includes("hunter2")));
  assert.ok(!texts.some((t) => t.includes("ancient")));
});

test("gatherRecentSources reads recent voice/vision thread messages with speaker labels", async () => {
  const voiceThread = createThread("claude", "auto", "auto");
  voiceThread.title = "voice";
  saveThread(voiceThread);
  await updateThread(voiceThread.id, (th) => {
    th.messages.push({ role: "user", text: "remember the deploy window is 9am", ts: Date.now() });
    th.messages.push({ role: "assistant", text: "saved.", ts: Date.now() });
  });

  const sources = gatherRecentSources({ notesDir: makeTempNotesDir() });
  const deployLine = sources.find((s) => s.text.includes("deploy window"));
  assert.ok(deployLine, "voice message present");
  assert.equal(deployLine!.label, "voice");
  assert.match(deployLine!.text, new RegExp("^" + DEFAULT_USER_CONFIG.displayName + ": "));
});

test("recentBuffer end-to-end: fresh note is findable; tiny queries skip", () => {
  const notesDir = makeTempNotesDir();
  fs.writeFileSync(
    path.join(notesDir, "note.md"),
    "the staging api key lives in the vault under vidi-staging"
  );
  const hit = recentBuffer("where is the staging api key", { notesDir });
  assert.ok(hit);
  assert.match(hit!, /vault/);

  assert.equal(recentBuffer("yes", { notesDir }), null);
});
