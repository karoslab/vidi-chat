import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — H4. The write-file confirm executor jail. Even a forged confirm
 * (B1 confirm-route auth deferred) may only write inside {workspace, Desktop,
 * Downloads}, and never a SECRET_PATHS credential/token or a $HOME dotfile.
 *
 * HOME is pointed at a temp dir with Desktop/Downloads so the allowlist roots
 * are real and isolated; WORKSPACE_ROOT is the module's own (fixed) value.
 */

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-jail-home-"));
fs.mkdirSync(path.join(HOME, "Desktop"), { recursive: true });
fs.mkdirSync(path.join(HOME, "Downloads"), { recursive: true });
process.env.HOME = HOME;

const { checkWriteFileTarget } = await import("../lib/write-file-jail.ts");
const { WORKSPACE_ROOT } = await import("../lib/workspace.ts");

function refused(p: string) {
  const r = checkWriteFileTarget(p);
  assert.equal(r.allowed, false, `expected REFUSE for ${p}`);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason!.length > 0, "a refusal must carry a plain-language reason");
}
function allowed(p: string) {
  const r = checkWriteFileTarget(p);
  assert.equal(r.allowed, true, `expected ALLOW for ${p}: ${r.reason ?? ""}`);
}

test("rejects ~/.ssh/authorized_keys (outside the three roots)", () => {
  refused(path.join(HOME, ".ssh", "authorized_keys"));
});

test("rejects ~/.zshrc (a $HOME dotfile)", () => {
  refused(path.join(HOME, ".zshrc"));
});

test("rejects a data/*-token path under the workspace (SECRET_PATHS)", () => {
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "control-token"));
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "phone-token"));
});

test("rejects data/accounts.json under the workspace (SECRET_PATHS)", () => {
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "accounts.json"));
});

// F1 — the owner-inference files. A forged write-file confirm must not be able
// to create/overwrite the files isOwner() reads to flip a non-owner to owner.
test("F1: rejects data/onboarded.json (owner signal) via the confirm jail", () => {
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "onboarded.json"));
});

test("F1: rejects data/user-config.json via the confirm jail", () => {
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "user-config.json"));
});

test("F1: rejects any data/threads/*.json (owner signal) via the confirm jail", () => {
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "threads", "t-1.json"));
  refused(path.join(WORKSPACE_ROOT, "vidi-chat", "data", "threads", "sub", "deep.json"));
});

test("rejects a .env file under an allowed root (SECRET_PATHS)", () => {
  refused(path.join(HOME, "Desktop", ".env.local"));
});

test("rejects a path entirely outside home (e.g. /etc)", () => {
  refused("/etc/hosts");
});

test("rejects a relative path", () => {
  refused("notes/todo.txt");
});

test("allows a normal Desktop write", () => {
  allowed(path.join(HOME, "Desktop", "letter-to-landlord.txt"));
});

test("allows a normal Downloads write", () => {
  allowed(path.join(HOME, "Downloads", "export.csv"));
});

test("allows a normal workspace write", () => {
  allowed(path.join(WORKSPACE_ROOT, "notes", "idea.md"));
});

// --- Batch A item 13: leading "~" is expanded BEFORE the jail check ----------

test("allows a ~/Desktop tilde path (expanded, not refused as 'relative')", () => {
  // The single most likely model emission for a home file. Before the expansion
  // it hit path.isAbsolute("~/Desktop/x")===false and was refused as relative
  // AFTER the human approved it — an allowed dir that could never work.
  allowed("~/Desktop/notes.txt");
});

test("allows a ~/Downloads tilde path", () => {
  allowed("~/Downloads/export.csv");
});

test("still refuses a ~/Documents tilde path (outside the three roots) with a spoken reason", () => {
  // Expansion doesn't widen the jail — an out-of-jail tilde path is still
  // refused, just now for the RIGHT reason (outside the roots) not "relative".
  const r = checkWriteFileTarget("~/Documents/x.txt");
  assert.equal(r.allowed, false);
  assert.match(r.reason ?? "", /workspace, Desktop, or Downloads/);
});
