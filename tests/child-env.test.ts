import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Tier-2 (S-env). The CLI child gets a minimal allowlisted env, NOT the full
 * process.env — so proxy keys, cloud credentials and topic secrets never reach
 * a process that runs model-directed Bash. Assert: secrets dropped, standard
 * operational vars kept, VIDI_* coordination vars carried, explicit overrides
 * win, and metered API keys are dropped (subscription-CLI contract).
 */

const { scrubbedChildEnv } = await import("../lib/child-env.ts");

const PARENT: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/example",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
  // Secrets that MUST NOT propagate:
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  VIDI_PROXY_KEY: undefined, // not a real var; ensure undefined skipped
  X_VIDI_KEY: "leak-me",
  NTFY_TOPIC: "private-topic",
  GITHUB_TOKEN: "ghp_secret",
  // vidi coordination var that SHOULD propagate:
  VIDI_AGENT_ID: "agent-7",
};

test("secrets are dropped, operational vars kept", () => {
  const env = scrubbedChildEnv({}, PARENT);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/Users/example");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.TERM, "xterm");
  for (const secret of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "X_VIDI_KEY",
    "NTFY_TOPIC",
    "GITHUB_TOKEN",
  ]) {
    assert.equal(env[secret], undefined, `${secret} must not leak to the child`);
  }
});

test("VIDI_* coordination vars carry through", () => {
  const env = scrubbedChildEnv({}, PARENT);
  assert.equal(env.VIDI_AGENT_ID, "agent-7");
});

test("explicit overrides win and are copied verbatim", () => {
  const env = scrubbedChildEnv(
    { VIDI_AGENT_DEPTH: "1", CLAUDE_CONFIG_DIR: "/tmp/alt" },
    PARENT
  );
  assert.equal(env.VIDI_AGENT_DEPTH, "1");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/alt");
});

test("undefined values are skipped, not stringified", () => {
  const env = scrubbedChildEnv({ FOO: undefined }, PARENT);
  assert.ok(!("FOO" in env));
  assert.ok(!("VIDI_PROXY_KEY" in env), "an undefined parent VIDI_ var is not added");
});

test("the real process.env does not leak a common secret shape", () => {
  // Belt-and-suspenders against the live env: whatever is set on this box, a
  // key-looking var must not survive into the scrubbed child unless allowlisted.
  const env = scrubbedChildEnv({}, { ...process.env, SOME_API_KEY: "sk-live-abc123" });
  assert.equal(env.SOME_API_KEY, undefined);
});
