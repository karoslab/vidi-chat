import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import url from "node:url";

const { expandTilde, homeRelative } = await import("../lib/expand-tilde.ts");

const HOME = process.env.HOME || os.homedir();

test("homeRelative collapses the home dir to ~ for display", () => {
  assert.equal(homeRelative(HOME), "~");
  assert.equal(homeRelative(path.join(HOME, "Brain")), "~" + path.sep + "Brain");
  assert.equal(
    homeRelative(path.join(HOME, "workspace", "vidi-chat")),
    "~" + path.sep + path.join("workspace", "vidi-chat")
  );
});

test("homeRelative leaves paths outside home unchanged", () => {
  assert.equal(homeRelative("/opt/data/wiki"), "/opt/data/wiki");
  // A sibling that merely shares the home prefix as a substring is NOT collapsed.
  assert.equal(homeRelative(HOME + "-backup/wiki"), HOME + "-backup/wiki");
});

test("homeRelative is the display inverse of expandTilde", () => {
  const abs = path.join(HOME, "notes", "a.md");
  assert.equal(expandTilde(homeRelative(abs)), abs);
});

// The scaffold route must surface a home-relative root (never an absolute
// filesystem path) while still creating the wiki at its real location.
const ROUTE = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "app",
  "api",
  "journey",
  "memory",
  "scaffold",
  "route.ts"
);
const src = fs.readFileSync(ROUTE, "utf8");

test("scaffold route returns a home-relative root, not the absolute path", () => {
  assert.match(src, /homeRelative\s*\(\s*result\.root\s*\)/);
  // The response ships the collapsed root, not result.root.
  assert.match(src, /Response\.json\(\s*\{\s*\.\.\.result,\s*root\b/);
});
