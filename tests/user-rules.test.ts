import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * lib/user-rules.ts — the owner's standing rules loader. Exercised against temp
 * HOME + VIDI_DATA_DIR dirs so it reads fixture files, never the real
 * ~/.claude/CLAUDE.md or the live data dir. Covers: missing files, overlay
 * append order, the ~8KB cap + truncation, mtime cache invalidation, and the
 * USER_RULES_ENABLED off switch.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-rules-home-"));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-rules-data-"));
process.env.HOME = home;
process.env.VIDI_DATA_DIR = data;
delete process.env.USER_RULES_ENABLED;

const globalFile = path.join(home, ".claude", "CLAUDE.md");
const overlayFile = path.join(data, "USER_RULES.md");
fs.mkdirSync(path.dirname(globalFile), { recursive: true });

// os.homedir() prefers $HOME on POSIX; confirm the fixture is what the module
// will read before relying on it.
assert.equal(os.homedir(), home, "test needs HOME to drive os.homedir()");

const {
  loadUserRules,
  userRulesBlock,
  userRulesEnabled,
  _resetUserRulesCache,
  MAX_RULES_BYTES,
  USER_RULES_HEADING,
} = await import("../lib/user-rules.ts");

function reset() {
  try {
    fs.rmSync(globalFile);
  } catch {
    /* absent */
  }
  try {
    fs.rmSync(overlayFile);
  } catch {
    /* absent */
  }
  delete process.env.USER_RULES_ENABLED;
  _resetUserRulesCache();
}

test("both files missing → empty string, no throw", () => {
  reset();
  assert.equal(loadUserRules(), "");
  assert.equal(userRulesBlock(), "");
});

test("global file only → its content, no overlay", () => {
  reset();
  fs.writeFileSync(globalFile, "GLOBAL RULES\n");
  assert.equal(loadUserRules(), "GLOBAL RULES");
});

test("overlay is appended AFTER the global file", () => {
  reset();
  fs.writeFileSync(globalFile, "GLOBAL RULES");
  fs.writeFileSync(overlayFile, "OVERLAY RULES");
  const out = loadUserRules();
  assert.equal(out, "GLOBAL RULES\n\nOVERLAY RULES");
  assert.ok(out.indexOf("GLOBAL") < out.indexOf("OVERLAY"));
});

test("overlay only (no global) still loads", () => {
  reset();
  fs.writeFileSync(overlayFile, "JUST OVERLAY");
  assert.equal(loadUserRules(), "JUST OVERLAY");
});

test("block carries the delimiter heading; empty rules → empty block", () => {
  reset();
  fs.writeFileSync(globalFile, "R");
  assert.equal(userRulesBlock(), `${USER_RULES_HEADING}\nR`);
  reset();
  assert.equal(userRulesBlock(), "");
});

test("combined text over the cap is truncated with a warning", () => {
  reset();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m?: unknown) => warns.push(String(m));
  try {
    fs.writeFileSync(globalFile, "x".repeat(MAX_RULES_BYTES + 5000));
    const out = loadUserRules();
    assert.ok(Buffer.byteLength(out, "utf8") <= MAX_RULES_BYTES);
    assert.ok(warns.some((w) => w.includes("truncated")));
  } finally {
    console.warn = orig;
  }
});

test("mtime cache invalidates when the file changes", () => {
  reset();
  fs.writeFileSync(globalFile, "V1");
  assert.equal(loadUserRules(), "V1");
  // Rewrite with a bumped mtime so the stat-based cache re-reads.
  fs.writeFileSync(globalFile, "V2");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(globalFile, future, future);
  assert.equal(loadUserRules(), "V2");
});

test("appearance/disappearance flips the cache", () => {
  reset();
  assert.equal(loadUserRules(), ""); // absent → cached empty
  fs.writeFileSync(globalFile, "NOW HERE");
  assert.equal(loadUserRules(), "NOW HERE"); // appearing re-reads
  fs.rmSync(globalFile);
  assert.equal(loadUserRules(), ""); // disappearing re-reads to empty
});

test("USER_RULES_ENABLED=0 disables injection", () => {
  reset();
  fs.writeFileSync(globalFile, "RULES");
  process.env.USER_RULES_ENABLED = "0";
  assert.equal(userRulesEnabled(), false);
  assert.equal(loadUserRules(), "");
  assert.equal(userRulesBlock(), "");
});

test("USER_RULES_ENABLED unset defaults to ON", () => {
  reset();
  fs.writeFileSync(globalFile, "RULES");
  assert.equal(userRulesEnabled(), true);
  assert.equal(loadUserRules(), "RULES");
});
