import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// intro-thread + store resolve data/ off process.cwd() at call time, so chdir
// into a fresh temp dir before importing — same isolation as onboarding.test.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-intro-test-")));

const { getOrCreateIntroThread, introThreadId, introOpeningMessage } =
  await import("../lib/intro-thread.ts");
const { listThreads, searchThreads, getThread } = await import("../lib/store.ts");
const { completeOnboarding } = await import("../lib/onboarding.ts");

// Serialize: these mutate process.cwd() (a global). One at a time.
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

function freshCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-intro-"));
  process.chdir(dir);
  return dir;
}

serial("creates an intro-typed thread seeded with a deterministic greeting", () => {
  freshCwd();
  const thread = getOrCreateIntroThread();
  assert.equal(thread.type, "intro");
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].role, "assistant");
  // Deterministic greeting, no model call — introduces Vidi and leads into the
  // starter prompts. Vidi's identity is fixed: it NEVER asks to be renamed, and
  // never asks the USER's name again (collected in onboarding step 1).
  assert.match(thread.messages[0].text, /Vidi/);
  assert.doesNotMatch(thread.messages[0].text.toLowerCase(), /call me/);
});

serial("the intro thread is EXCLUDED from the sidebar list and search", () => {
  freshCwd();
  const thread = getOrCreateIntroThread();
  // It's persisted and directly fetchable...
  assert.ok(getThread(thread.id));
  // ...but never appears in the normal thread list or search.
  assert.equal(listThreads().some((t) => t.id === thread.id), false);
  assert.equal(searchThreads("Vidi").some((t) => t.id === thread.id), false);
  assert.equal(searchThreads("Getting started").some((t) => t.id === thread.id), false);
});

serial("re-triggering reuses the SAME intro thread (no duplicates)", () => {
  freshCwd();
  const first = getOrCreateIntroThread();
  const second = getOrCreateIntroThread();
  assert.equal(first.id, second.id);
  assert.equal(introThreadId(), first.id);
  // Only one intro thread file on disk.
  const threadsDir = path.join(process.cwd(), "data", "threads");
  const files = fs.readdirSync(threadsDir).filter((f) => f.endsWith(".json"));
  const introFiles = files.filter((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(threadsDir, f), "utf8"));
    return t.type === "intro";
  });
  assert.equal(introFiles.length, 1);
});

serial("introThreadId is null before any intro thread exists", () => {
  freshCwd();
  assert.equal(introThreadId(), null);
});

serial("greeting tone varies by the onboarding personality (persona reuse)", () => {
  // Pure composer: distinct openers per tone. Every opener names Vidi and NEVER
  // asks to be renamed (fixed identity) or re-asks the user's own name.
  const warm = introOpeningMessage("warm");
  const direct = introOpeningMessage("direct");
  const playful = introOpeningMessage("playful");
  const none = introOpeningMessage(null);
  const all = [warm, direct, playful, none];
  for (const line of all) {
    assert.match(line, /Vidi/);
    // Never asks to be renamed.
    assert.doesNotMatch(line.toLowerCase(), /call me/);
    // Never re-asks the user's own name.
    assert.doesNotMatch(line.toLowerCase(), /call you/);
  }
  // The three personalities produce three distinct openers.
  assert.equal(new Set([warm, direct, playful]).size, 3);
});

serial("a completed onboarding profile flavors the seeded greeting (warm)", () => {
  freshCwd();
  completeOnboarding({ name: "Maya", personality: "warm" });
  const thread = getOrCreateIntroThread();
  // The seeded greeting is the warm opener — Vidi introduces herself, never
  // writes the user's name from the intro (that's displayName, untouched).
  assert.equal(thread.messages[0].text, introOpeningMessage("warm"));
});

serial("a completed onboarding profile flavors the seeded greeting", () => {
  freshCwd();
  completeOnboarding({ name: "Maya", personality: "playful" });
  const thread = getOrCreateIntroThread();
  // The seeded greeting matches the playful opener (persona wired through).
  assert.equal(thread.messages[0].text, introOpeningMessage("playful"));
});
