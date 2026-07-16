import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — the isOwner signal that gates Auto-mode defaults and outward
 * egress. The owner keeps Auto-capable defaults + TTS/push; a fresh
 * onboarded install (Maya) is a NON-owner: Plan-mode default, zero external
 * network calls.
 *
 * Resolution: env VIDI_OWNER wins; else the onboarded flag's provenance
 * ("existing-install" = owner, "flow" = non-owner); else "has threads" heuristic
 * (pre-existing install = owner, fresh install = non-owner).
 *
 * Each case points VIDI_DATA_DIR at its own temp dir so the real install's data/
 * never leaks in. A cache-busted import re-reads env each case.
 */

type UserConfigModule = typeof import("../lib/user-config.ts");
function importUserConfig(tag: string): Promise<UserConfigModule> {
  const spec = "../lib/user-config.ts" + "?owner=" + tag;
  return import(/* @vite-ignore */ spec) as Promise<UserConfigModule>;
}

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-owner-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  process.env.VIDI_DATA_DIR = path.join(dir, "data");
  return dir;
}

function writeOnboardedFlag(source: "flow" | "existing-install"): void {
  fs.writeFileSync(
    path.join(process.env.VIDI_DATA_DIR!, "onboarded.json"),
    JSON.stringify({ onboarded: true, source, at: new Date().toISOString() })
  );
}

function writeThread(): void {
  const threadsDir = path.join(process.env.VIDI_DATA_DIR!, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(path.join(threadsDir, "t-1.json"), JSON.stringify({ id: "t-1" }));
}

test.beforeEach(() => {
  delete process.env.VIDI_OWNER;
  delete process.env.VIDI_DATA_DIR;
});

test.afterEach(() => {
  delete process.env.VIDI_OWNER;
  delete process.env.VIDI_DATA_DIR;
});

test("fresh onboarded install (source=flow) is NON-owner → plan default", async () => {
  freshDataDir();
  writeOnboardedFlag("flow");
  const { isOwner } = await importUserConfig("flow");
  assert.equal(isOwner(), false);
});

test("backfilled existing install (source=existing-install) is OWNER", async () => {
  freshDataDir();
  writeOnboardedFlag("existing-install");
  const { isOwner } = await importUserConfig("existing");
  assert.equal(isOwner(), true);
});

test("VIDI_OWNER=1 forces owner even on a fresh flow install", async () => {
  freshDataDir();
  writeOnboardedFlag("flow");
  process.env.VIDI_OWNER = "1";
  const { isOwner } = await importUserConfig("env-on");
  assert.equal(isOwner(), true);
});

test("VIDI_OWNER=0 forces non-owner even on an existing-install", async () => {
  freshDataDir();
  writeOnboardedFlag("existing-install");
  process.env.VIDI_OWNER = "0";
  const { isOwner } = await importUserConfig("env-off");
  assert.equal(isOwner(), false);
});

test("no flag, existing threads → owner (backfill not yet stamped)", async () => {
  freshDataDir();
  writeThread();
  const { isOwner } = await importUserConfig("threads");
  assert.equal(isOwner(), true);
});

test("no flag, no threads (truly fresh) → non-owner (safe default)", async () => {
  freshDataDir();
  const { isOwner } = await importUserConfig("bare");
  assert.equal(isOwner(), false);
});

/**
 * The load-bearing behavioral wiring: the voice thread's DEFAULT mode flips on
 * ownership. Owner → auto (unchanged); non-owner → plan (Auto now requires an
 * explicit toggle). findOrCreateVoiceThread (lib/voice-turn.ts:79) creates the
 * thread with exactly `isOwner() ? "auto" : "plan"`; voice-turn.ts uses the
 * "@/" alias so it can't import under plain node --test — assert the decision
 * that drives that literal, which IS the behavioral contract.
 */
test("voice default-mode decision: owner → auto, non-owner → plan", async () => {
  freshDataDir();
  writeOnboardedFlag("existing-install");
  const owner = await importUserConfig("voice-owner");
  assert.equal(owner.isOwner() ? "auto" : "plan", "auto");

  freshDataDir();
  writeOnboardedFlag("flow");
  const nonOwner = await importUserConfig("voice-nonowner");
  assert.equal(nonOwner.isOwner() ? "auto" : "plan", "plan");
});
