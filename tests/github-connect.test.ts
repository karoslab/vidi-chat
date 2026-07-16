import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * These exercise the gh-CLI wrapper against a FAKE `gh` (a shell script pointed
 * at by GH_BIN, the same override lib/swarm-github.ts uses) so no network or
 * real GitHub account is touched. The fake's behaviour is driven by FAKE_GH_*
 * env vars set per test.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-gh-"));
const FAKE_GH = path.join(tmp, "gh");
fs.writeFileSync(
  FAKE_GH,
  `#!/bin/sh
sub="$1 $2"
case "$sub" in
  "auth status")
    if [ "$FAKE_GH_CONNECTED" = "1" ]; then
      echo "github.com"
      echo "  Logged in to github.com account testuser (keyring)"
      exit 0
    fi
    echo "You are not logged into any GitHub hosts." 1>&2
    exit 1 ;;
  "api user")
    if [ "$FAKE_GH_CONNECTED" = "1" ]; then echo "testuser"; exit 0; fi
    echo "HTTP 401: Bad credentials" 1>&2
    exit 1 ;;
  "auth login")
    if [ "$FAKE_GH_SILENT_LOGIN" = "1" ]; then
      # Simulate a gh build/locale whose output matches neither CODE_RE nor
      # the bare fallback: print nothing parseable and block on stdin, exactly
      # like real gh does while waiting for Enter. Only the scrape timeout
      # (and the SIGTERM cancelPendingFlow sends) can end this.
      read _ignore
      exit 0
    fi
    echo "! First copy your one-time code: ABCD-1234" 1>&2
    echo "- Press Enter to open https://github.com/login/device in your browser..." 1>&2
    read _ignore
    exit 0 ;;
  "repo view")
    if [ "$FAKE_GH_REPO_EXISTS" = "1" ]; then echo '{"name":"my-vidi-memory"}'; exit 0; fi
    echo "GraphQL: Could not resolve to a Repository" 1>&2
    exit 1 ;;
  "repo create")
    echo "https://github.com/testuser/my-vidi-memory"; exit 0 ;;
  "auth setup-git") exit 0 ;;
  *) echo "unexpected: $@" 1>&2; exit 3 ;;
esac
`,
  { mode: 0o755 }
);
process.env.GH_BIN = FAKE_GH;

const gh = await import("../lib/github-connect.ts");

test("status(): parses connected + login from gh auth status", async () => {
  process.env.FAKE_GH_CONNECTED = "1";
  const s = await gh.status();
  assert.equal(s.connected, true);
  assert.equal(s.login, "testuser");
});

test("status(): reports disconnected when gh is not logged in", async () => {
  delete process.env.FAKE_GH_CONNECTED;
  const s = await gh.status();
  assert.equal(s.connected, false);
  assert.equal(s.login, null);
});

test("status(): reports notInstalled when gh binary is missing", async () => {
  const prev = process.env.GH_BIN;
  process.env.GH_BIN = path.join(tmp, "gh-does-not-exist");
  const s = await gh.status();
  assert.equal(s.notInstalled, true);
  process.env.GH_BIN = prev;
});

test("apiWhoAmI(): a real API call succeeds when connected", async () => {
  process.env.FAKE_GH_CONNECTED = "1";
  const r = await gh.apiWhoAmI();
  assert.deepEqual(r, { ok: true, login: "testuser" });
});

test("apiWhoAmI(): revoked/absent credential fails with a plain reason", async () => {
  delete process.env.FAKE_GH_CONNECTED;
  const r = await gh.apiWhoAmI();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(typeof r.reason, "string");
});

test("startDeviceFlow(): captures the one-time code + verification URL", async () => {
  process.env.FAKE_GH_CONNECTED = "1"; // so the post-exit status() lookup finds the login
  const flow = await gh.startDeviceFlow();
  assert.equal(flow.userCode, "ABCD-1234");
  assert.match(flow.verificationUri, /github\.com\/login\/device/);
  const done = await flow.completion;
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.login, "testuser");
});

test("startDeviceFlow(): a code that never parses times out instead of hanging forever", async () => {
  // Regression for the HOLD finding: a gh whose output matches neither
  // CODE_RE nor the bare fallback must not leave the promise unsettled.
  process.env.FAKE_GH_SILENT_LOGIN = "1";
  process.env.VIDI_GH_DEVICE_TIMEOUT_MS = "150"; // short so the test doesn't wait 30s
  const startedAt = Date.now();
  await assert.rejects(gh.startDeviceFlow(), (err: Error) => {
    assert.equal(typeof err.message, "string");
    assert.ok(err.message.length > 0);
    assert.doesNotMatch(err.message, /[—–]/); // plain-language, no em/en dashes
    return true;
  });
  // Bounded, not instant-zero (it really waited for the timeout) and not the
  // real 30s default (it really used the override).
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 100 && elapsed < 5000, `expected a ~150ms bounded wait, got ${elapsed}ms`);
  delete process.env.FAKE_GH_SILENT_LOGIN;
  delete process.env.VIDI_GH_DEVICE_TIMEOUT_MS;
});

test("ensureWikiBackupRepo(): reuses an existing repo (idempotent, no create)", async () => {
  process.env.FAKE_GH_REPO_EXISTS = "1";
  const r = await gh.ensureWikiBackupRepo("testuser");
  assert.deepEqual(r, { ok: true, fullName: "testuser/my-vidi-memory" });
  delete process.env.FAKE_GH_REPO_EXISTS;
});

test("ensureWikiBackupRepo(): creates the repo when missing", async () => {
  delete process.env.FAKE_GH_REPO_EXISTS;
  const r = await gh.ensureWikiBackupRepo("testuser");
  assert.equal(r.ok, true);
  assert.equal(r.fullName, "testuser/my-vidi-memory");
});

test("pushWikiBackup(): BLOCKS the push when a file looks like it holds a secret", async () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-wiki-secret-"));
  fs.writeFileSync(path.join(wiki, "note.md"), "my aws key AKIAIOSFODNN7EXAMPLE");
  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "secret-blocked");
  assert.ok((r.secrets ?? []).length >= 1);
  assert.match(r.reason || "", /password or key/i);
});

test("pushWikiBackup(): reports nothing-to-back-up for a missing folder", async () => {
  const r = await gh.pushWikiBackup(path.join(tmp, "no-such-wiki"), "testuser/my-vidi-memory");
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /nothing to back up/i);
});

test("pushWikiBackup(): clean content pushes ONLY the wiki repo, on main", async () => {
  // Local bare repo stands in for the private GitHub backup; url.insteadOf
  // rewrites https://github.com/ to it so no network is used.
  const bareParent = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-bare-"));
  const bare = path.join(bareParent, "testuser", "my-vidi-memory.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", bare]);

  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-wiki-clean-"));
  fs.writeFileSync(path.join(wiki, "memory.md"), "I like tea in the morning.");
  execFileSync("git", ["init", wiki]);
  execFileSync("git", ["-C", wiki, "config", `url.${bareParent}/.insteadOf`, "https://github.com/"]);

  const prevEnv = { ...process.env };
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Vidi";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "vidi@example.com";

  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");
  Object.assign(process.env, prevEnv);

  assert.equal(r.ok, true, r.reason || "expected pushWikiBackup to succeed");
  // The push landed on `main` in the (only) backup repo.
  const ref = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
  assert.match(ref, /^[0-9a-f]{40}$/);
});

/* -------------------------------------------------------------------------- */
/* first-backup failure modes on a fresh account (2026-07-12 live repro)      */
/* -------------------------------------------------------------------------- */

/** Build a wiki dir wired (via url.insteadOf) to a local bare repo standing in
 *  for the private GitHub backup, so no network or real account is touched. */
function wikiWiredTo(bareParent: string, content: Record<string, string>): string {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-wiki-"));
  for (const [name, body] of Object.entries(content)) fs.writeFileSync(path.join(wiki, name), body);
  execFileSync("git", ["init", wiki]);
  execFileSync("git", ["-C", wiki, "config", `url.${bareParent}/.insteadOf`, "https://github.com/"]);
  return wiki;
}

/** Seed a bare backup repo with a `main` that already carries `files`. */
function seedBackup(bareParent: string, files: Record<string, string>): string {
  const bare = path.join(bareParent, "testuser", "my-vidi-memory.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", bare]);
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-seed-"));
  execFileSync("git", ["init", seed]);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(seed, name), body);
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "-c", "user.name=Old", "-c", "user.email=old@example.com", "commit", "-m", "prior backup"]);
  execFileSync("git", ["-C", seed, "branch", "-M", "main"]);
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", seed, "push", "origin", "main"]);
  return bare;
}

test("first backup: fresh account with NO git identity still commits and pushes", async () => {
  // Simulate a fresh macOS standard account: no global/system git user at all.
  const emptyGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-noid-"));
  const cfg = path.join(emptyGlobal, "gitconfig");
  fs.writeFileSync(cfg, "");
  const prev = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;

  const bareParent = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-bare-"));
  const bare = path.join(bareParent, "testuser", "my-vidi-memory.git");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["init", "--bare", bare]);
  const wiki = wikiWiredTo(bareParent, { "memory.md": "I take my chai with ginger." });

  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");

  // A repo-scoped identity was set (never global) so the commit could happen.
  const localEmail = execFileSync("git", ["-C", wiki, "config", "--local", "user.email"]).toString().trim();
  Object.assign(process.env, prev);
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete (process.env as any)[k];

  assert.equal(r.ok, true, r.reason || "expected the fresh-account backup to succeed");
  assert.match(localEmail, /users\.noreply\.github\.com$/);
  const ref = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
  assert.match(ref, /^[0-9a-f]{40}$/);
});

test("first backup: existing repo, DISJOINT history rebases cleanly onto main", async () => {
  const bareParent = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-bare-"));
  const bare = seedBackup(bareParent, { "other.md": "an older note" });
  const wiki = wikiWiredTo(bareParent, { "memory.md": "a brand new memory" });

  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");
  assert.equal(r.ok, true, r.reason || "expected a clean rebase + push");
  // main now carries BOTH the prior note and the new memory: nothing lost.
  const tree = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"]).toString();
  assert.match(tree, /other\.md/);
  assert.match(tree, /memory\.md/);
});

test("first backup: existing repo, CONFLICTING history is saved to a fresh branch, main untouched", async () => {
  const bareParent = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-bare-"));
  const bare = seedBackup(bareParent, { "memory.md": "REMOTE content" });
  const mainBefore = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
  const wiki = wikiWiredTo(bareParent, { "memory.md": "LOCAL content" });

  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");
  assert.equal(r.ok, true, r.reason || "expected a safe fresh-branch save");
  assert.match(r.reason || "", /separate backup/i);
  // The customer's existing backup on main is byte-for-byte untouched.
  const mainAfter = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"]).toString().trim();
  assert.equal(mainAfter, mainBefore, "main must not be overwritten");
  // The new memory landed on its own vidi-backup-* branch.
  const branches = execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).toString();
  assert.match(branches, /vidi-backup-/);
});

test("first backup: a push failure reads as a BACKUP problem, never the connect lie", async () => {
  // Point the backup remote at a path with no repo so the push fails. The
  // customer must NOT see "The connection didn't finish" after a good connect.
  const bareParent = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-noremote-"));
  const wiki = wikiWiredTo(bareParent, { "memory.md": "something to save" });

  const r = await gh.pushWikiBackup(wiki, "testuser/my-vidi-memory");
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, "The connection didn't finish. Please start again.");
  assert.match(r.reason || "", /backup/i);
  assert.doesNotMatch(r.reason || "", /[—–]/); // plain copy, no em/en dashes
});
