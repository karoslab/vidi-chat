import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACT_ALLOWED_TOOLS,
  ACT_DISALLOWED_TOOLS,
  SECRET_PATHS,
  SECRET_READ_DENIES,
} from "../lib/providers/claude.ts";

/**
 * Phase 4a — P5. Auto (act) mode is gated behind the OWNER's approval, not the
 * non-owner's own toggle. The owner always has act mode; a non-owner
 * (Maya) gets it only when the owner set VIDI_ACT_OPT_IN — she cannot grant it
 * to herself from inside the app. This is the enforcement behind the onboarding
 * promise "Vidi suggests; she doesn't act on your behalf yet".
 */

type UserConfigModule = typeof import("../lib/user-config.ts");
function importUserConfig(tag: string): Promise<UserConfigModule> {
  return import(/* @vite-ignore */ "../lib/user-config.ts" + "?actoptin=" + tag) as Promise<UserConfigModule>;
}
type PushModule = typeof import("../lib/push.ts");
function importPush(tag: string): Promise<PushModule> {
  return import(/* @vite-ignore */ "../lib/push.ts" + "?actoptin=" + tag) as Promise<PushModule>;
}

function nonOwnerDataDir(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-actoptin-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "onboarded.json"),
    JSON.stringify({ onboarded: true, source: "flow" })
  );
  process.env.VIDI_DATA_DIR = path.join(dir, "data");
}

test.afterEach(() => {
  delete process.env.VIDI_DATA_DIR;
  delete process.env.VIDI_OWNER;
  delete process.env.VIDI_ACT_OPT_IN;
});

test("owner always has act mode (no opt-in needed)", async () => {
  process.env.VIDI_OWNER = "1";
  const { actModeAllowed } = await importUserConfig("owner");
  assert.equal(actModeAllowed(), true);
});

test("non-owner WITHOUT the owner opt-in cannot act (clamped to Plan)", async () => {
  nonOwnerDataDir();
  const { actModeAllowed, isOwner } = await importUserConfig("nonowner-noopt");
  assert.equal(isOwner(), false);
  assert.equal(actModeAllowed(), false);
});

test("non-owner WITH the owner-set VIDI_ACT_OPT_IN may act", async () => {
  nonOwnerDataDir();
  process.env.VIDI_ACT_OPT_IN = "1";
  const { actModeAllowed } = await importUserConfig("nonowner-opt");
  assert.equal(actModeAllowed(), true);
});

test("a falsey opt-in value does not grant act mode", async () => {
  nonOwnerDataDir();
  for (const v of ["0", "false", "no", "", "  "]) {
    process.env.VIDI_ACT_OPT_IN = v;
    const { actModeAllowed } = await importUserConfig("nonowner-falsey-" + encodeURIComponent(v));
    assert.equal(actModeAllowed(), false, `opt-in "${v}" must NOT grant act mode`);
  }
});

/**
 * Item 7 — the full BUILDER-MODE matrix (non-owner install + VIDI_ACT_OPT_IN=1,
 * the exact shape of the first external customer). Act must be granted (so
 * claude.ts's `actModeAllowed() ? mode : "plan"` clamp does NOT fire), yet every
 * act rail must still bind AND egress must stay off — builder mode widens the
 * mode surface, never the trust boundary.
 */
test("builder mode grants act but is NOT the owner (clamp precondition, egress precondition)", async () => {
  nonOwnerDataDir();
  process.env.VIDI_ACT_OPT_IN = "1";
  const { actModeAllowed, isOwner } = await importUserConfig("builder-grant");
  // Granted → claude.ts line ~465 keeps normalizeMode(args.mode); no clamp to plan.
  assert.equal(actModeAllowed(), true);
  // Still not the owner → egress + owner-only defaults stay off (below).
  assert.equal(isOwner(), false);
});

test("builder mode: all act rails still bind (the write/push/secret jail is owner-independent)", () => {
  const allowed = ACT_ALLOWED_TOOLS.split(",");
  const denied = ACT_DISALLOWED_TOOLS.split(",");

  // GIT_PUSH_PROTECTED — direct pushes to master/main denied in builder mode too.
  for (const rule of [
    "Bash(git push)",
    "Bash(git push origin main*)",
    "Bash(git push origin master*)",
    "Bash(git push -f*)",
    "Bash(gh pr merge*)",
    "Bash(gh api*)",
  ]) {
    assert.ok(denied.includes(rule), `builder mode missing git/gh deny: ${rule}`);
  }

  // SECRET_PATHS bind as Read/Edit/Write denies — a credential can't be touched.
  for (const secret of [
    "~/.ssh/**",
    "**/.env*",
    "~/.aws/**",
    "**/.claude/.credentials.json",
    "**/data/onboarded.json",
    "**/data/user-config.json",
    "**/data/threads/**",
  ]) {
    assert.ok(SECRET_PATHS.includes(secret), `builder mode missing secret path: ${secret}`);
    for (const verb of ["Read", "Edit", "Write"]) {
      assert.ok(
        denied.includes(`${verb}(${secret})`),
        `builder mode missing ${verb} deny for ${secret}`
      );
    }
  }

  // The dangerous interpreters stay OFF the allowlist (no raw node/python3).
  assert.ok(!allowed.includes("Bash(node *)"), "raw node must not be allowed in builder mode");
  assert.ok(!allowed.includes("Bash(python3 *)"), "raw python3 must not be allowed in builder mode");
  // But the build/PR workflow the customer needs is present.
  assert.ok(allowed.includes("Bash(git *)"));
  assert.ok(allowed.includes("Bash(gh *)"));
  assert.ok(allowed.includes("Bash(mkdir *)"), "scaffolding a site needs mkdir");
  assert.ok(allowed.includes("Write"), "scaffolding a site needs Write (workspace-jailed)");

  // Plan-mode Read denies are derived from the SAME SECRET_PATHS (no drift).
  assert.equal(SECRET_READ_DENIES, SECRET_PATHS.map((p) => `Read(${p})`).join(","));
});

test("builder mode: outward egress (push to phone) stays a no-op for the non-owner", async () => {
  nonOwnerDataDir();
  process.env.VIDI_ACT_OPT_IN = "1";
  const push = await importPush("builder-egress");
  let transportCalls = 0;
  push.registerTransport(async () => {
    transportCalls++;
    return true;
  }, "spy");
  push.resetDeliveries();

  const delivered = await push.pushToPhone("t", "b", "high");
  assert.equal(delivered, false, "builder mode must not open egress: nothing delivered");
  assert.equal(transportCalls, 0, "no transport may run for a non-owner even with the act opt-in");
});
