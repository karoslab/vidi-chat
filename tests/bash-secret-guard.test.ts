import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 4a — P3 (threat-model B5). The Bash-lane secret-read guard. The act-mode
 * Bash allowlist admits `Bash(cat *)`, `Bash(head *)`, `Bash(cp *)`, … so the
 * SECRET_PATHS deny (which binds only Read/Edit/Write) never sees a
 * `cat ~/.codex/auth.json`. This guard closes that lane by matching the PATH
 * SET anywhere in the command — not a binary allow/deny list — so cat / head /
 * less / cp / base64 / dd / strings / xxd / a `>` redirect all get caught.
 */

const HOME = process.env.HOME || "/Users/example";

const { bashCommandTouchesSecret } = await import(
  "../lib/bash-secret-guard.ts"
);

// The exact acceptance vector from the plan: an act-mode read of the codex token.
test("cat ~/.codex/auth.json is blocked (the B5 acceptance vector)", () => {
  const v = bashCommandTouchesSecret("cat ~/.codex/auth.json");
  assert.equal(v.blocked, true);
});

test("blocks a spread of read tools against the secret set (not a binary list)", () => {
  const blocked = [
    "head ~/.ssh/id_rsa",
    "less ~/.aws/credentials",
    "cp ~/.codex/auth.json /tmp/x",
    "base64 ~/.config/gcloud/application_default_credentials.json",
    "dd if=~/.ssh/id_ed25519 of=/tmp/k",
    "strings ~/Library/Keychains/login.keychain-db",
    "xxd ~/.claude/.credentials.json",
    // $HOME and ${HOME} expansions must resolve to the same secret.
    "cat $HOME/.codex/auth.json",
    "cat ${HOME}/.codex/auth.json",
    // Quoted path.
    'cat "~/.ssh/id_rsa"',
    // Quote-obfuscation INSIDE the path — the shell reads these as the single
    // path ~/.codex/auth.json; an injected payload can emit them to dodge a
    // naive splitter, so they must still be caught (B5 evasion).
    'cat ~/.co"dex"/auth.json',
    "cat ~/.co'dex'/auth.json",
    'cat ~/".codex"/auth.json',
    "base64 ~/.ss''h/id_rsa",
    // Secret referenced mid-pipeline, not as the first word.
    "echo hi && cat ~/.codex/auth.json | pbcopy",
    // A data/ token by its trailing-path glob, even relative.
    "cat data/control-token",
  ];
  for (const cmd of blocked) {
    assert.equal(
      bashCommandTouchesSecret(cmd).blocked,
      true,
      `expected BLOCK: ${cmd}`
    );
  }
});

// Directory-level exfil: naming the parent DIR of a secret (not the file) used
// to slip past the guard, so `cp -r ~/.ssh ~/Downloads/x` copied private keys
// to a freely-readable place with one allowlisted command (B5). The dir and its
// ancestors (for whole-dir secrets) must block too.
test("blocks recursive copies of a secret DIRECTORY or its ancestors", () => {
  const blocked = [
    "cp -r ~/.ssh ~/Downloads/x", // private keys
    "cp -r ~/.codex ~/Downloads/x", // openai token dir
    "cp -r ~/.aws /tmp/x", // cloud creds
    "rsync -a ~/.config/gcloud ~/Downloads/", // gcloud creds (rsync, not cp)
    "cp -r ~/.claude ~/Downloads/x", // holds .credentials.json
    "cp -r data ~/Downloads/d", // per-install tokens: control/hands/phone/accounts
    "tar -czf /tmp/s.tgz ~/.ssh", // archived, not copied
    "cp -r $HOME/.aws /tmp/x", // $HOME form
    "cp -r ~ /tmp/home", // copying all of $HOME grabs every secret dir
  ];
  for (const cmd of blocked) {
    assert.equal(
      bashCommandTouchesSecret(cmd).blocked,
      true,
      `expected BLOCK: ${cmd}`
    );
  }
});

test("allows ordinary commands that touch no secret path", () => {
  const allowed = [
    "cat README.md",
    "ls -la ~/workspace",
    "head -n 20 ./notes/codex-summary.md", // 'codex' in a filename, not the dir
    "git status",
    "npm run build",
    `cat ${HOME}/Desktop/todo.txt`,
    "grep -r foo lib/",
    // The workspace root and its subdirs are Vidi's normal work area — copying
    // or listing them must NOT be blocked just because a data/ dir lives under
    // the tree somewhere. Only naming the sensitive dir ITSELF blocks.
    "cp -r ~/workspace/vidi-chat ~/Downloads/backup",
    "ls ~/workspace/vidi-chat",
    "mkdir data-backup", // a segment merely starting with 'data' is not the data dir
    "cp -r ~/Downloads/photos ~/Desktop/",
  ];
  for (const cmd of allowed) {
    assert.equal(
      bashCommandTouchesSecret(cmd).blocked,
      false,
      `expected ALLOW: ${cmd}`
    );
  }
});

test("empty / non-string command is a no-op (fail-open on nothing to inspect)", () => {
  assert.equal(bashCommandTouchesSecret("").blocked, false);
  assert.equal(bashCommandTouchesSecret("   ").blocked, false);
  assert.equal(bashCommandTouchesSecret(undefined).blocked, false);
});

test("reports the offending token so the deny reason / journal can name it", () => {
  const v = bashCommandTouchesSecret("base64 ~/.codex/auth.json");
  assert.equal(v.blocked, true);
  assert.match(v.match ?? "", /\.codex\/auth\.json/);
});

// P8 finding 4 (P7 re-audit) — the backslash evasion. A backslash before an
// ordinary char is a no-op escape in the shell, so `cat ~/.co\dex/auth.json`
// reads the SAME file as `cat ~/.codex/auth.json` — but the old tokenizer kept
// the backslash, so the path never matched the ~/.codex/** glob and slipped
// through. Stripping `\` (alongside quotes) collapses it back to the real path.
test("P8: backslash-escaped secret path is blocked (the \\-evasion)", () => {
  // Source `\\d` → one literal backslash in the command string the guard sees.
  assert.equal(bashCommandTouchesSecret("cat ~/.co\\dex/auth.json").blocked, true);
  assert.equal(bashCommandTouchesSecret("cat ~/.ss\\h/id_rsa").blocked, true);
  // Mixed backslash + quote obfuscation in one path still resolves + blocks.
  assert.equal(bashCommandTouchesSecret('base64 ~/.co\\d"ex"/auth.json').blocked, true);
});
