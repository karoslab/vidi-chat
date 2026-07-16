import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — H8. A NON-owner install (Maya) makes ZERO external network calls,
 * so the security notice's "nothing else leaves your computer" is literally
 * true for her. Prove the two off-machine egress chokepoints short-circuit:
 *   - pushToPhone (ntfy + Discord) → no transport runs, returns false,
 *   - the TTS-route gate decision (isOwner) → off for non-owner, on for owner.
 * Owner installs are unchanged (transport still runs).
 */

// Cache-busted imports built at runtime so tsc resolves the base module for
// types (not the literal query-string spec) — the user-config.test.ts pattern.
type PushModule = typeof import("../lib/push.ts");
function importPush(tag: string): Promise<PushModule> {
  return import(/* @vite-ignore */ "../lib/push.ts" + "?h8=" + tag) as Promise<PushModule>;
}
type UserConfigModule = typeof import("../lib/user-config.ts");
function importUserConfig(tag: string): Promise<UserConfigModule> {
  return import(/* @vite-ignore */ "../lib/user-config.ts" + "?h8=" + tag) as Promise<UserConfigModule>;
}

function ownedDataDir(source: "flow" | "existing-install"): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-egress-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "onboarded.json"),
    JSON.stringify({ onboarded: true, source })
  );
  process.env.VIDI_DATA_DIR = path.join(dir, "data");
}

test.beforeEach(() => {
  delete process.env.VIDI_DATA_DIR;
  delete process.env.VIDI_OWNER;
});

test.afterEach(() => {
  delete process.env.VIDI_DATA_DIR;
  delete process.env.VIDI_OWNER;
});

test("pushToPhone is a no-op for a non-owner (no transport runs)", async () => {
  ownedDataDir("flow");
  const push = await importPush("nonowner-push");
  let transportCalls = 0;
  push.registerTransport(async () => {
    transportCalls++;
    return true;
  }, "spy");
  push.resetDeliveries();

  const delivered = await push.pushToPhone("t", "b", "high");
  assert.equal(delivered, false, "non-owner push must report nothing delivered");
  assert.equal(transportCalls, 0, "no transport (ntfy/discord/spy) may run for a non-owner");
});

test("pushToPhone still runs its transport chain for the owner", async () => {
  ownedDataDir("existing-install");
  const push = await importPush("owner-push");
  let transportCalls = 0;
  push.registerTransport(async () => {
    transportCalls++;
    return true; // first success wins for a non-critical priority
  }, "spy");
  push.resetDeliveries();

  const delivered = await push.pushToPhone("t", "b", "default");
  assert.equal(delivered, true, "owner push delivers via a transport");
  assert.ok(transportCalls >= 1, "owner push must actually run a transport");
});

test("TTS-route gate: disabled for non-owner, enabled for owner", async () => {
  ownedDataDir("flow");
  const nonOwner = await importUserConfig("tts-nonowner");
  assert.equal(nonOwner.isOwner(), false, "non-owner TTS route short-circuits (no worker fetch)");

  ownedDataDir("existing-install");
  const owner = await importUserConfig("tts-owner");
  assert.equal(owner.isOwner(), true, "owner TTS route reaches the worker as before");
});
