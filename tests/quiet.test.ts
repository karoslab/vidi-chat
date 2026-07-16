import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// quiet.ts computes QUIET_FILE = path.join(process.cwd(), "data/quiet.json")
// once at module-load. Chdir into a temp dir first; then manage the one fixed
// path explicitly between tests rather than trying to switch cwd.
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-quiet-test-"));
process.chdir(testCwd);

const { isQuiet, setQuiet } = await import("../lib/quiet.ts");

const QUIET_FILE = path.join(testCwd, "data", "quiet.json");

function resetQuiet() {
  try { fs.rmSync(QUIET_FILE); } catch { /* absent is fine */ }
}

let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

serial("isQuiet returns false when file is absent (fail-open — missing file must never silence Vidi)", () => {
  resetQuiet();
  assert.equal(isQuiet(), false);
});

serial("isQuiet returns false on corrupt JSON (fail-open — corrupt file must never silence Vidi)", () => {
  resetQuiet();
  fs.mkdirSync(path.dirname(QUIET_FILE), { recursive: true });
  fs.writeFileSync(QUIET_FILE, "NOT JSON {{{");
  assert.equal(isQuiet(), false);
});

serial("setQuiet(true) persists and isQuiet reads it back as true", () => {
  resetQuiet();
  setQuiet(true);
  assert.equal(isQuiet(), true);
});

serial("setQuiet(false) after setQuiet(true) flips isQuiet back to false", () => {
  resetQuiet();
  setQuiet(true);
  assert.equal(isQuiet(), true);
  setQuiet(false);
  assert.equal(isQuiet(), false);
});
