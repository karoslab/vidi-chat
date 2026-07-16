import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

/**
 * Phase 4a — H3. Plan-mode read scope. The owner keeps the whole
 * $HOME readable via a single `--add-dir HOME_DIR`; a non-owner (Maya) is
 * restricted to the dirs her writes are jailed to (workspace + brain + Desktop
 * + Downloads), so a Plan-mode turn can't walk the rest of home.
 */

const { planModeAddDirs } = await import("../lib/providers/claude.ts");

const HOME_DIR = process.env.HOME || "/Users/example";

test("owner plan-mode scope is the whole home (unchanged)", () => {
  const dirs = planModeAddDirs(true);
  assert.deepEqual(dirs, [HOME_DIR]);
});

test("non-owner plan-mode scope excludes the bare $HOME", () => {
  const dirs = planModeAddDirs(false);
  // The whole-home grant must NOT be present for a non-owner.
  assert.ok(
    !dirs.includes(HOME_DIR),
    "non-owner must not get --add-dir $HOME"
  );
  // Every returned dir must be strictly inside the home tree (or the workspace),
  // never $HOME itself — i.e. a proper subdirectory, matching her write jail.
  for (const dir of dirs) {
    assert.notEqual(dir, HOME_DIR);
  }
});

test("non-owner plan-mode scope is never empty (workspace always readable)", () => {
  const dirs = planModeAddDirs(false);
  assert.ok(dirs.length >= 1, "non-owner scope must include at least the workspace");
});
