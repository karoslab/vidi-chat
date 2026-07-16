import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — P3 (threat-model B5). End-to-end contract of the PreToolUse(Bash)
 * hook script the act-mode CLI child runs. The CLI pipes each Bash tool call as
 * JSON on stdin; the hook must DENY a secret-read and JOURNAL it, and stay out
 * of the way of everything else. Drives the real script the way the CLI does —
 * spawn `node hooks/deny-secret-read.ts`, pipe the hook JSON, read stdout +
 * the journal — so this is the actual acceptance test, not a mock.
 */

const HOOK = path.resolve("hooks/deny-secret-read.ts");

/** Run the hook the way the CLI does: pipe a PreToolUse JSON on stdin, with the
 *  data dir pointed at an isolated temp dir so we can read the journal it writes. */
function runHook(payload: unknown): {
  stdout: string;
  status: number | null;
  dataDir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-hook-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, VIDI_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  return { stdout: res.stdout ?? "", status: res.status, dataDir };
}

function preToolUse(command: string): unknown {
  return {
    session_id: "voice-abc",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

function journalEntries(dataDir: string): Array<Record<string, unknown>> {
  const file = path.join(dataDir, "journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("act-mode Bash(cat ~/.codex/auth.json) is DENIED and JOURNALED", () => {
  const { stdout, status, dataDir } = runHook(preToolUse("cat ~/.codex/auth.json"));

  // Denied via the structured PreToolUse decision.
  const decision = JSON.parse(stdout);
  assert.equal(
    decision.hookSpecificOutput.permissionDecision,
    "deny",
    "the hook must deny the secret read"
  );
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.ok(
    typeof decision.hookSpecificOutput.permissionDecisionReason === "string" &&
      decision.hookSpecificOutput.permissionDecisionReason.length > 0
  );
  assert.equal(status, 0, "a structured deny exits 0 so stdout is honored");

  // Journaled, so the block is durable and readable back.
  const entries = journalEntries(dataDir);
  const denied = entries.find((e) => e.tool === "bash-secret-read-denied");
  assert.ok(denied, "the denied read must be journaled");
  assert.equal(denied!.threadId, "voice-abc");
  assert.match(String(denied!.summary), /\.codex\/auth\.json/);
});

test("an ordinary Bash read is allowed and NOT journaled (no deny output)", () => {
  const { stdout, status, dataDir } = runHook(preToolUse("cat README.md"));
  assert.equal(stdout.trim(), "", "an allowed command produces no deny decision");
  assert.equal(status, 0);
  assert.equal(
    journalEntries(dataDir).length,
    0,
    "an allowed command is not journaled by the deny hook"
  );
});

test("unparseable stdin fails open (allow) — a broken hook never wedges a turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-hook-"));
  const res = spawnSync(process.execPath, [HOOK], {
    input: "not json at all",
    env: { ...process.env, VIDI_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal((res.stdout ?? "").trim(), "");
});
