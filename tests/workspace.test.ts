import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type WorkspaceModule = typeof import("../lib/workspace.ts");

// The default brain-dir name comes from the config module (a neutral default now);
// sourcing it here keeps the canonical-layout probe tracking whatever the module
// resolves, rather than restating a literal.
import { DEFAULT_USER_CONFIG } from "../lib/user-config.ts";

// Fresh module instance per call: the query string cache-busts Node's module
// cache so WORKSPACE_ROOT is re-resolved (it reads the env var at import time).
// Built at runtime so tsc resolves the base module for types, not the literal.
function importWorkspace(tag: string): Promise<WorkspaceModule> {
  const spec = "../lib/workspace.ts" + "?case=" + tag;
  return import(/* @vite-ignore */ spec) as Promise<WorkspaceModule>;
}

/**
 * WORKSPACE_ROOT is the single source of truth for locating vidi-chat's
 * siblings (the brain dir, vidi, ops, …) after a workspace-root path migration.
 * These tests pin its two resolution modes:
 *   1. derived from the module location (default), and
 *   2. overridden by VIDI_WORKSPACE_ROOT.
 *
 * The module reads the env var at import time, so each mode is exercised in its
 * own freshly-imported module instance (cache-busted query string).
 */

test("default: WORKSPACE_ROOT is the parent of the vidi-chat dir and holds the expected siblings", async (t) => {
  delete process.env.VIDI_WORKSPACE_ROOT;

  // This test file lives at <root>/vidi-chat/tests/workspace.test.ts, so the
  // workspace root is two levels up from here — independent of how the module
  // itself derives it. That makes this an end-to-end check, not a tautology.
  const expectedRoot = path.resolve(import.meta.dirname, "..", "..");

  // ENVIRONMENTAL GUARD: this case pins the owner's canonical workspace root layout
  // (a checkout literally named vidi-chat with the real brain/vidi/ops siblings).
  // In any other layout — a git worktree, a fresh second-user install (whose
  // Mac has no brain/vidi/ops siblings) — those assertions describe the ENVIRONMENT,
  // not the code, so skip rather than fail confusingly. The override case below
  // still exercises the resolution logic everywhere.
  const canonicalLayout =
    fs.existsSync(path.join(expectedRoot, "vidi-chat", "package.json")) &&
    path.basename(path.resolve(import.meta.dirname, "..")) === "vidi-chat" &&
    [DEFAULT_USER_CONFIG.brainDirName, "vidi", "ops"].every((sibling) =>
      fs.existsSync(path.join(expectedRoot, sibling))
    );
  if (!canonicalLayout) {
    t.skip(
      "environmental: requires the canonical layout (checkout named vidi-chat with brain/vidi/ops siblings) — absent in worktrees and fresh second-user installs"
    );
    return;
  }

  const { WORKSPACE_ROOT, workspacePath } = await importWorkspace("default");
  assert.equal(WORKSPACE_ROOT, expectedRoot);

  // The root must be the PARENT of the vidi-chat directory.
  assert.equal(path.basename(path.resolve(WORKSPACE_ROOT, "vidi-chat")), "vidi-chat");
  assert.ok(
    fs.existsSync(path.join(WORKSPACE_ROOT, "vidi-chat")),
    "workspace root should contain the vidi-chat dir",
  );

  // The siblings vidi-chat's hardcoded paths used to point at.
  for (const sibling of [DEFAULT_USER_CONFIG.brainDirName, "vidi", "ops"]) {
    assert.ok(
      fs.existsSync(path.join(WORKSPACE_ROOT, sibling)),
      `workspace root should contain sibling: ${sibling}`,
    );
  }

  // workspacePath joins under the root.
  assert.equal(
    workspacePath(DEFAULT_USER_CONFIG.brainDirName, "wiki", DEFAULT_USER_CONFIG.userModelFileName),
    path.join(WORKSPACE_ROOT, DEFAULT_USER_CONFIG.brainDirName, "wiki", DEFAULT_USER_CONFIG.userModelFileName),
  );
});

test("first-run website-build smoke: a fresh install with NO workspace root can scaffold under the resolved root", async () => {
  // Item 8. Mimic the first external customer: a temp HOME with no workspace root
  // (so nothing leans on the owner's real layout) and a relocated workspace root
  // the Vidi Helper payload sets via VIDI_WORKSPACE_ROOT. WORKSPACE_ROOT must
  // resolve there, and an act-mode session (cwd = WORK_DIR = WORKSPACE_ROOT)
  // must be able to mkdir + write a site scaffold under it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-home-"));
  const relocated = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ws-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home; // no workspace root exists under this HOME
    process.env.VIDI_WORKSPACE_ROOT = relocated;
    assert.equal(fs.existsSync(path.join(home, "Workspace")), false);

    const { WORKSPACE_ROOT, workspacePath } = await importWorkspace("firstrun");
    assert.equal(WORKSPACE_ROOT, path.resolve(relocated));

    // Scaffold a site exactly as an act-mode `mkdir` + `Write` would, jailed to
    // the workspace root — proving the write target is creatable/writable on a
    // box that has never seen workspace root.
    const siteDir = workspacePath("my-first-site");
    fs.mkdirSync(siteDir, { recursive: true });
    const indexHtml = path.join(siteDir, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>My site</title>");
    assert.ok(fs.existsSync(indexHtml), "scaffolded index.html should exist under the workspace root");
    // And it landed UNDER the resolved root, not somewhere in the temp HOME.
    assert.ok(indexHtml.startsWith(path.resolve(relocated)));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.VIDI_WORKSPACE_ROOT;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(relocated, { recursive: true, force: true });
  }
});

test("VIDI_WORKSPACE_ROOT overrides the derived root", async () => {
  const override = fs.mkdtempSync(path.join(process.cwd(), "ws-override-"));
  try {
    process.env.VIDI_WORKSPACE_ROOT = override;
    const { WORKSPACE_ROOT, workspacePath } = await importWorkspace("override");

    assert.equal(WORKSPACE_ROOT, path.resolve(override));
    assert.equal(
      workspacePath("ops", "notify.py"),
      path.join(path.resolve(override), "ops", "notify.py"),
    );
  } finally {
    delete process.env.VIDI_WORKSPACE_ROOT;
    fs.rmSync(override, { recursive: true, force: true });
  }
});
