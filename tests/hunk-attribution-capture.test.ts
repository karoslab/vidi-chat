import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end proof of the capture mechanism against the LIVE flow (a real git
 * repo + a real filesystem edit), not synthetic before/after strings:
 * openSession snapshots the working tree, a file is edited as an agent would,
 * closeSession runs the boundary git-diff and journals the attributed change.
 *
 * chdir into the temp repo BEFORE importing so data-dir.ts resolves data/ under
 * it — the window store and journal live there, isolated from the real repo.
 */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-hunk-capture-"));

function git(args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

git(["init", "-q"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "Test"]);
fs.writeFileSync(path.join(repo, "app.ts"), "line1\nline2\nline3\n");
git(["add", "app.ts"]);
git(["commit", "-q", "-m", "init"]);

process.chdir(repo);

const { openSession, closeSession, snapshotWorkspace, captureChangesSince } = await import(
  "../lib/hunk-attribution.ts"
);
const { readJournal } = await import("../lib/journal.ts");

test("a real edit during a session becomes a FileChange journal entry attributed to the agent", () => {
  // Session opens: baseline is the clean HEAD tree.
  openSession("agent-42", 1000, repo);

  // The agent edits a tracked file (real write to the working tree).
  fs.writeFileSync(path.join(repo, "app.ts"), "line1\nEDITED\nline3\n");

  // Session closes: boundary diff captures app.ts and journals it.
  closeSession("agent-42", 2000);

  const entries = readJournal();
  const fileChange = entries.find((e) => e.tool === "FileChange" && e.summary.includes("app.ts"));
  assert.ok(fileChange, "a FileChange entry for app.ts must be journaled");
  assert.deepEqual(fileChange!.attribution, [{ actor: "agent-42", hunks: 1 }]);
});

test("a change captured with a ts outside every window is attributed to external", () => {
  // Snapshot now (after the previous test closed agent-42's window at 2000),
  // edit, then capture with a ts (5000) that falls in no open window.
  const baseline = snapshotWorkspace(repo);
  assert.ok(baseline, "temp dir must be a git repo");
  fs.writeFileSync(path.join(repo, "app.ts"), "line1\nEDITED\nAGAIN\n");

  captureChangesSince("no-session", baseline!, repo, 5000);

  const fileChange = readJournal().find(
    (e) => e.tool === "FileChange" && e.summary.includes("app.ts") && e.ts === 5000
  );
  assert.ok(fileChange, "the external change must be journaled");
  assert.deepEqual(fileChange!.attribution, [{ actor: "external", hunks: 1 }]);
});

test("overlapping concurrent act sessions skip capture (no cross-attribution or double-journal)", () => {
  // A tracked file that only this test touches, so the assertion is independent
  // of the app.ts entries the earlier tests journaled.
  fs.writeFileSync(path.join(repo, "concurrent.ts"), "a\nb\nc\n");
  git(["add", "concurrent.ts"]);
  git(["commit", "-q", "-m", "add concurrent.ts"]);

  // Two act agents editing the same repo with overlapping windows.
  openSession("conc-A", 10000, repo);
  openSession("conc-B", 15000, repo);
  fs.writeFileSync(path.join(repo, "concurrent.ts"), "a\nEDIT\nc\n");
  closeSession("conc-A", 20000); // B still open → overlaps → skip
  closeSession("conc-B", 30000); // A closed but overlapped B → skip

  const captured = readJournal().filter(
    (e) => e.tool === "FileChange" && e.summary.includes("concurrent.ts")
  );
  assert.equal(captured.length, 0, "overlapping sessions must not journal the shared edit");
});
