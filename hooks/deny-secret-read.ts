#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook — Phase 4a P3 (threat-model B5).
 *
 * Wired into the act-mode `claude` CLI child via `--settings` (see
 * lib/providers/claude.ts, actModePreToolUseSettings). Before every Bash tool
 * call the CLI pipes the call as JSON on stdin; we deny any command that
 * references a SECRET_PATHS-protected credential/token file (matched by PATH,
 * not binary — cat/head/less/cp/base64/dd/strings/redirect/… all caught) and
 * journal the block. Everything else is allowed (exit 0, no output).
 *
 * Denial uses the documented PreToolUse structured decision: a stdout JSON with
 * hookSpecificOutput.permissionDecision = "deny" plus a plain-language reason
 * the model sees. Fail-open on unparseable input — a hook that errors must never
 * wedge a turn (the Read/Edit/Write denylist + write-file jail are the other
 * layers).
 */
import { appendJournal } from "../lib/journal.ts";
import { bashCommandTouchesSecret } from "../lib/bash-secret-guard.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    process.exit(0); // unparseable stdin → allow (nothing to inspect)
  }

  const toolInput = payload.tool_input as { command?: unknown } | undefined;
  const command = typeof toolInput?.command === "string" ? toolInput.command : "";
  const verdict = bashCommandTouchesSecret(command);
  if (!verdict.blocked) process.exit(0);

  const threadId = typeof payload.session_id === "string" ? payload.session_id : "act";
  appendJournal({
    ts: Date.now(),
    threadId,
    tool: "bash-secret-read-denied",
    summary: command,
  });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "That command reads a protected secret or credential file — secrets are " +
          "walled off, even from Bash. Do a different, non-secret read instead.",
      },
    })
  );
  process.exit(0);
}

void main();
