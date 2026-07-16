import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Branch-discipline guard (Journey Stage 4, requirement 6). The wiki backup is
 * the ONLY direct-push surface Vidi has. Everything else (project work) pushes
 * to BRANCHES through the agent session, which lib/providers/claude.ts protects
 * against main via GIT_PUSH_PROTECTED. This test fails if a second direct-push
 * path is ever added to the GitHub wrapper, or if the one push stops targeting
 * the wiki backup remote on main.
 */

const src = fs.readFileSync(new URL("../lib/github-connect.ts", import.meta.url), "utf8");

test("github-connect.ts issues exactly one git push", () => {
  const pushCalls = src.match(/\["push"/g) || [];
  assert.equal(pushCalls.length, 1, "expected a single git push call in the whole module");
});

test("the one push targets the 'backup' remote (main, or a fresh branch on divergence)", () => {
  // The push ref is computed: normally "main"; on a genuinely divergent existing
  // backup it becomes a fresh dated branch (HEAD:vidi-backup-...) so we land the
  // snapshot without touching the customer's existing history. Either way the
  // remote is always 'backup'.
  assert.match(src, /\["push",\s*"-u",\s*"backup",\s*pushRef\]/);
  assert.match(src, /pushRef\s*=\s*"main"/);
});

test("the one push is never forced (no overwrite of existing backup data)", () => {
  assert.doesNotMatch(src, /--force|force-with-lease|"\+refs|:\+/);
});

test("repo provisioning functions never push", () => {
  // Isolate each provisioning function's own body (up to its closing brace at
  // column 0) and assert it contains no actual git-push CALL. Matching the
  // call token (`["push"`), not the word "push", so a neighbouring doc comment
  // that merely DISCUSSES pushing (e.g. "it NEVER pushes") can't false-positive.
  for (const name of ["ensureWikiBackupRepo", "ensureProjectRepo"]) {
    const start = src.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} should exist`);
    const rest = src.slice(start);
    const closeBrace = rest.indexOf("\n}\n");
    const body = closeBrace >= 0 ? rest.slice(0, closeBrace) : rest;
    assert.doesNotMatch(body, /\["push"/, `${name} must not call git push`);
  }
});

test("the push lives inside pushWikiBackup", () => {
  const fn = src.indexOf("export async function pushWikiBackup");
  const push = src.indexOf('["push"');
  assert.ok(fn >= 0 && push > fn, "the push must be inside pushWikiBackup");
});
