import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 4a — H2. The claude provider's SECRET_PATHS denylist binds Read/Edit/
 * Write for every act-mode turn. It must cover every live credential/token on
 * the box, not just ~/.ssh, because Plan mode still allows un-jailed Read (the
 * primary Maya-facing exfil surface). Assert both the raw glob set and that
 * each glob is emitted into the CLI's --disallowedTools string in all three
 * Read/Edit/Write forms.
 */

const { SECRET_PATHS, ACT_DISALLOWED_TOOLS } = await import(
  "../lib/providers/claude.ts"
);

const NEW_DENY_GLOBS = [
  "~/.aws/**",
  "~/.config/gcloud/**",
  "**/.claude/.credentials.json",
  "~/.claude-profiles/**",
  "~/.codex/**",
  "~/Library/Keychains/**",
  "**/data/phone-token",
  "**/data/control-token",
  "**/data/accounts.json",
];

test("every H2 credential glob is present in SECRET_PATHS", () => {
  for (const glob of NEW_DENY_GLOBS) {
    assert.ok(
      SECRET_PATHS.includes(glob),
      `SECRET_PATHS must deny ${glob}`
    );
  }
});

test("each new glob is bound as Read+Edit+Write in --disallowedTools", () => {
  for (const glob of NEW_DENY_GLOBS) {
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.ok(
        ACT_DISALLOWED_TOOLS.includes(`${tool}(${glob})`),
        `${tool}(${glob}) must be in ACT_DISALLOWED_TOOLS`
      );
    }
  }
});

test("the original ~/.ssh deny is still present (no regression)", () => {
  assert.ok(SECRET_PATHS.includes("~/.ssh/**"));
  assert.ok(ACT_DISALLOWED_TOOLS.includes("Read(~/.ssh/**)"));
});

// F1 — the owner-inference files isOwner() reads. Denying them to the agent's
// Read/Edit/Write tools closes the Auto-mode Write vector for the privilege
// escalation (the write-file confirm executor is covered in write-file-jail.test).
const F1_OWNER_SIGNAL_GLOBS = [
  "**/data/onboarded.json",
  "**/data/user-config.json",
  "**/data/threads/**",
];

test("F1: owner-signal globs are present in SECRET_PATHS", () => {
  for (const glob of F1_OWNER_SIGNAL_GLOBS) {
    assert.ok(SECRET_PATHS.includes(glob), `SECRET_PATHS must deny ${glob}`);
  }
});

test("F1: owner-signal globs are bound as Read+Edit+Write in --disallowedTools", () => {
  for (const glob of F1_OWNER_SIGNAL_GLOBS) {
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.ok(
        ACT_DISALLOWED_TOOLS.includes(`${tool}(${glob})`),
        `${tool}(${glob}) must be in ACT_DISALLOWED_TOOLS`
      );
    }
  }
});

// P8 finding 4 (P7 re-audit) — browser/phone bearer tokens the P7 lenses found
// still readable through the Read/Bash lane. Denying them to the agent's tools
// closes the "read the session token → own the browser read/config surface" and
// "read the phone pairing cookie/code → own the paired-phone surface" gaps.
const P8_TOKEN_GLOBS = [
  "**/data/session-token",
  "**/data/phone-browser-cookie",
  "**/data/phone-pairing-code",
];

test("P8: browser/phone bearer-token globs are present in SECRET_PATHS", () => {
  for (const glob of P8_TOKEN_GLOBS) {
    assert.ok(SECRET_PATHS.includes(glob), `SECRET_PATHS must deny ${glob}`);
  }
});

test("P8: browser/phone bearer-token globs are bound as Read+Edit+Write", () => {
  for (const glob of P8_TOKEN_GLOBS) {
    for (const tool of ["Read", "Edit", "Write"]) {
      assert.ok(
        ACT_DISALLOWED_TOOLS.includes(`${tool}(${glob})`),
        `${tool}(${glob}) must be in ACT_DISALLOWED_TOOLS`
      );
    }
  }
});

// Grok provider — .grok/auth.json is a live xAI session token, and sessions/
// transcripts + logs/ under the tree can carry secrets. Deny the whole tree so
// no other provider's Read/Bash lane can lift it (mirrors ~/.codex/**).
test("grok credential tree is denied in SECRET_PATHS and bound Read+Edit+Write", () => {
  assert.ok(SECRET_PATHS.includes("~/.grok/**"), "SECRET_PATHS must deny ~/.grok/**");
  for (const tool of ["Read", "Edit", "Write"]) {
    assert.ok(
      ACT_DISALLOWED_TOOLS.includes(`${tool}(~/.grok/**)`),
      `${tool}(~/.grok/**) must be in ACT_DISALLOWED_TOOLS`
    );
  }
});
