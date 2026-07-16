import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Batch A item 6 — the shell confirm executor crash. startTerminal used to spawn
 * with the payload's cwd verbatim (no tilde expansion, no existence check) and
 * registered NO 'error' listener: a nonexistent cwd made spawn return pid
 * `undefined` (a false "success (pid -1)" spoken to the approver) and then emit
 * an unhandled 'error' event that crashed the whole vidi-chat server. Now
 * startTerminal validates/expands the cwd BEFORE spawn and the executor speaks a
 * clean refusal for a bad cwd — never a false pid, never a crash.
 *
 * Isolate cwd first — terminal logfiles live under cwd/data/terminals.
 */

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-terminals-test-"));
process.chdir(CWD);
fs.mkdirSync(path.join(CWD, "data"), { recursive: true });

const T0 = 1_000_000_000_000;

const { startTerminal, stopTerminal, TerminalCwdError } = await import(
  "../lib/terminals.ts"
);
const { fileConfirm, confirmPending, cancelPending } = await import(
  "../lib/confirm.ts"
);

test("startTerminal throws TerminalCwdError for a nonexistent cwd (no false pid)", () => {
  const missing = path.join(CWD, "does-not-exist-xyz");
  assert.throws(
    () => startTerminal("echo hi", missing),
    (err: unknown) => err instanceof TerminalCwdError && (err as any).attemptedCwd === missing
  );
});

test("startTerminal expands a leading ~ and spawns against the real home subdir", () => {
  // Point HOME at a temp dir with a real subdir; "~/sub" must resolve to it.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fake-home-"));
  fs.mkdirSync(path.join(fakeHome, "sub"));
  const priorHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const term = startTerminal("true", "~/sub");
    // A real pid (> 0) means the cwd resolved and spawn succeeded — not the old
    // false "pid -1". The resolved cwd is the expanded absolute path.
    assert.ok(term.pid > 0, `expected a real pid, got ${term.pid}`);
    assert.equal(term.cwd, path.join(fakeHome, "sub"));
    stopTerminal(term.id);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
  }
});

test("shell executor: a bad cwd speaks a folder-doesn't-exist refusal, never a false pid", async () => {
  cancelPending(T0);
  const missing = path.join(CWD, "nope-not-here");
  const { nonce } = fileConfirm(
    {
      kind: "shell",
      payload: { cmd: "echo hi", cwd: missing },
      description: "run echo hi",
    },
    { now: T0 }
  );
  const res = await confirmPending(T0, { nonce });
  assert.equal(res.ran, true);
  // A speakable refusal that names the folder — NOT "pid -1", NOT a crash.
  assert.match(res.text, /doesn't exist/i);
  assert.match(res.text, /nope-not-here/);
  assert.doesNotMatch(res.text, /pid/i);
});
