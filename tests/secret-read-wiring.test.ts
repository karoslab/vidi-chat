import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 4a — P3 (threat-model B5) wiring. Two belts around the Bash-lane hook:
 *   1. the act-mode CLI child gets a PreToolUse(Bash) hook that runs
 *      hooks/deny-secret-read.ts (the secret-read guard), and
 *   2. plan mode denies Read of every SECRET_PATHS glob (un-jailed Read was the
 *      primary non-owner exfil surface).
 */

const { actModePreToolUseSettings, SECRET_READ_DENIES, SECRET_PATHS } =
  await import("../lib/providers/claude.ts");

test("act mode registers a PreToolUse(Bash) hook that runs the deny-secret-read script", () => {
  const settings = actModePreToolUseSettings();
  const pre = settings.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length >= 1);
  const bash = pre.find((h) => h.matcher === "Bash");
  assert.ok(bash, "there must be a PreToolUse matcher for Bash");
  const cmd = bash!.hooks[0];
  assert.equal(cmd.type, "command");
  assert.match(
    cmd.command,
    /deny-secret-read\.ts/,
    "the hook must invoke hooks/deny-secret-read.ts"
  );
});

test("plan-mode Read-deny belt covers every SECRET_PATHS glob", () => {
  const denied = SECRET_READ_DENIES.split(",");
  for (const glob of SECRET_PATHS) {
    assert.ok(
      denied.includes(`Read(${glob})`),
      `plan-mode belt must deny Read(${glob})`
    );
  }
  // Spot-check the two credential paths the audit named directly.
  assert.ok(SECRET_READ_DENIES.includes("Read(~/.codex/**)"));
  assert.ok(SECRET_READ_DENIES.includes("Read(~/.config/gcloud/**)"));
});
