import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude provider: the owner's standing rules must land in the value passed to the
 * CLI's `--append-system-prompt` flag — i.e. buildSystemPrompt()'s output. We
 * point os.homedir() at a fixture holding ~/.claude/CLAUDE.md (mocking the file
 * read) and assert the delimited block is PREPENDED before the persona. Same
 * guarantee as the codex + grok provider tests.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-rules-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-claude-home-"));
fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
fs.writeFileSync(
  path.join(fakeHome, ".claude", "CLAUDE.md"),
  "RULE: skip the hedging and disclaimers."
);
process.env.HOME = fakeHome;

const { buildSystemPrompt } = await import("../lib/providers/claude.ts");
const { USER_RULES_HEADING } = await import("../lib/user-rules.ts");

test("rules block is prepended to the claude system prompt", () => {
  const sys = buildSystemPrompt("plan");
  assert.ok(sys.startsWith(USER_RULES_HEADING), "block must lead the system prompt");
  assert.ok(sys.includes("skip the hedging and disclaimers"), "rules body present");
});

test("USER_RULES_ENABLED=0 removes the block from the claude system prompt", () => {
  // userRulesEnabled() short-circuits before any file read, so no cache reset
  // is needed here.
  process.env.USER_RULES_ENABLED = "0";
  const sys = buildSystemPrompt("auto");
  assert.ok(!sys.includes(USER_RULES_HEADING), "disabled → no rules block");
  delete process.env.USER_RULES_ENABLED;
});
