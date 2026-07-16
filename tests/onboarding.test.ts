import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// onboarding.ts resolves data/ off process.cwd() at call time, so chdir into a
// fresh temp dir before importing — same isolation pattern as goals.test.ts.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-onb-test-")));

const {
  isOnboarded,
  readProfile,
  markOnboarded,
  completeOnboarding,
  personaToneBlock,
  PERSONALITIES,
} = await import("../lib/onboarding.ts");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-onb-"));
  process.chdir(dir);
  return dir;
}

function dataPath(...seg: string[]): string {
  return path.join(process.cwd(), "data", ...seg);
}

/**
 * The Maya-tier gate. Two hard guarantees:
 *   1. a fresh install (no threads, no flag) is NOT onboarded → shows the flow,
 *   2. an EXISTING install (one or more saved threads) is onboarded even with
 *      no flag file — the "existing data = onboarded" rule that protects
 *      the owner. Completing the flow persists the profile + display name.
 */

serial("fresh install is not onboarded", async () => {
  freshCwd();
  assert.equal(isOnboarded(), false);
  assert.equal(readProfile(), null);
});

serial("existing data (a saved thread) marks the install onboarded", async () => {
  freshCwd();
  // No flag file, but a thread exists → an existing user; never onboard them.
  fs.mkdirSync(dataPath("threads"), { recursive: true });
  fs.writeFileSync(dataPath("threads", "abc123.json"), JSON.stringify({ id: "abc123" }));
  assert.equal(isOnboarded(), true);
  // And crucially: this happens with NO onboarded.json present.
  assert.equal(fs.existsSync(dataPath("onboarded.json")), false);
});

serial("markOnboarded writes the flag and flips the gate", async () => {
  freshCwd();
  assert.equal(isOnboarded(), false);
  markOnboarded("existing-install");
  assert.equal(isOnboarded(), true);
  const flag = JSON.parse(fs.readFileSync(dataPath("onboarded.json"), "utf8"));
  assert.equal(flag.onboarded, true);
  assert.equal(flag.source, "existing-install");
});

serial("completeOnboarding persists profile + display name + flag", async () => {
  freshCwd();
  const profile = completeOnboarding({ name: "  Maya  ", personality: "direct" });
  assert.equal(profile.name, "Maya"); // trimmed
  assert.equal(profile.personality, "direct");

  // Profile file written.
  const saved = readProfile();
  assert.equal(saved?.name, "Maya");

  // Display name written into user-config.json so the app addresses her by name.
  const cfg = JSON.parse(fs.readFileSync(dataPath("user-config.json"), "utf8"));
  assert.equal(cfg.displayName, "Maya");

  // Onboarded flag set with source "flow".
  assert.equal(isOnboarded(), true);
  const flag = JSON.parse(fs.readFileSync(dataPath("onboarded.json"), "utf8"));
  assert.equal(flag.source, "flow");
});

serial("completeOnboarding coerces a bad personality and empty name safely", async () => {
  freshCwd();
  const profile = completeOnboarding({ name: "   ", personality: "nonsense" as any });
  assert.equal(profile.name, "there"); // empty name → friendly fallback
  assert.equal(profile.personality, "warm"); // unknown id → default
});

serial("completeOnboarding merges, never clobbers, existing user-config keys", async () => {
  freshCwd();
  fs.mkdirSync(dataPath(), { recursive: true });
  fs.writeFileSync(dataPath("user-config.json"), JSON.stringify({ brainDirName: "MayaWiki" }));
  completeOnboarding({ name: "Maya", personality: "warm" });
  const cfg = JSON.parse(fs.readFileSync(dataPath("user-config.json"), "utf8"));
  assert.equal(cfg.displayName, "Maya"); // added
  assert.equal(cfg.brainDirName, "MayaWiki"); // preserved
});

/**
 * T1.5 — onboarding replay safety. Replay re-shows the flow but must never
 * rewrite an existing profile. The component guards this (its finish() returns
 * early in replay mode), and the SERVER guards it too: once onboarded,
 * isOnboarded() stays true, so the route's completeOnboarding call is
 * unreachable. This asserts that server-side invariant — a completed profile
 * keeps the gate closed against any re-onboard.
 */
serial("replay-safety: after completing, the install stays onboarded (no re-onboard)", async () => {
  freshCwd();
  const first = completeOnboarding({ name: "Maya", personality: "warm" });
  assert.equal(isOnboarded(), true);
  // A replay's exit does NOT call completeOnboarding — but even if a stray call
  // reached it, the profile from the first run is what persists. Simulate the
  // gate the route consults: still onboarded, profile intact.
  assert.equal(isOnboarded(), true);
  assert.equal(readProfile()?.name, first.name);
});

serial("PERSONALITIES exposes at least one option with id+label", () => {
  assert.ok(PERSONALITIES.length >= 1);
  for (const p of PERSONALITIES) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.label, "string");
  }
});

/**
 * T1.1 — personality → persona tone block. The three offered personalities each
 * yield a DISTINCT tone instruction, and the absence case (no profile) yields
 * null so the system prompt stays byte-identical to today's default behavior.
 */
serial("personaToneBlock yields a distinct block for each personality", () => {
  const blocks = PERSONALITIES.map((p) =>
    personaToneBlock({ name: "Maya", personality: p.id, createdAt: 0 })
  );
  // Every personality produces a non-empty block.
  for (const block of blocks) {
    assert.equal(typeof block, "string");
    assert.ok((block as string).length > 0);
  }
  // And the three blocks are all different from one another.
  assert.equal(new Set(blocks).size, PERSONALITIES.length);
});

serial("personaToneBlock returns null with no profile (absence-case regression)", () => {
  // The default install (the owner, no profile) must get NO tone block so the
  // system prompt is unchanged.
  assert.equal(personaToneBlock(null), null);
});

serial("personaToneBlock returns null for an unrecognized personality", () => {
  assert.equal(
    personaToneBlock({ name: "x", personality: "nonsense" as any, createdAt: 0 }),
    null
  );
});
