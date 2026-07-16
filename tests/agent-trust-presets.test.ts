import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Agent trust-marker pre-writing (ported from Orca). Before vidi-chat spawns a
 * coding-agent CLI it pre-writes that CLI's folder-trust artifact so a fresh
 * install never hits a first-run "trust this folder?" gate.
 *
 * Isolation: VIDI_WORKSPACE_ROOT is pointed at a real temp dir so the module's
 * workspace root (and its assertTrustable bound) is that dir, and HOME is a
 * separate temp dir so the ~/.claude.json and ~/.codex/config.toml writes land
 * in the fixture, never on the real machine.
 */

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-ws-"));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-home-"));
process.env.VIDI_WORKSPACE_ROOT = WORKSPACE;
process.env.HOME = HOME;

const {
  markClaudeWorkspaceTrusted,
  markCodexWorkspaceTrusted,
  isTrustableWorkspace,
} = await import("../lib/agent-trust-presets.ts");
const { WORKSPACE_ROOT } = await import("../lib/workspace.ts");

// Sanity: the override took, so every path below is judged against the fixture.
assert.equal(fs.realpathSync(WORKSPACE_ROOT), fs.realpathSync(WORKSPACE));

const claudeConfig = path.join(HOME, ".claude.json");
const codexConfig = path.join(HOME, ".codex", "config.toml");
const wsReal = fs.realpathSync(WORKSPACE);

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// --- the safety bound: refuse anything outside the workspace root ------------

test("isTrustableWorkspace: root and inside are trustable, outside is not", () => {
  assert.equal(isTrustableWorkspace(WORKSPACE), true);
  assert.equal(isTrustableWorkspace(path.join(WORKSPACE, "vidi-chat")), true);
  assert.equal(isTrustableWorkspace(os.homedir()), false);
  assert.equal(isTrustableWorkspace("/etc"), false);
  // A sibling that merely shares a string prefix is NOT inside the root.
  assert.equal(isTrustableWorkspace(WORKSPACE + "-evil"), false);
});

test("markClaudeWorkspaceTrusted refuses a path outside the workspace root", () => {
  assert.throws(
    () => markClaudeWorkspaceTrusted(os.homedir()),
    /outside the vidi-chat workspace root/
  );
  assert.throws(
    () => markClaudeWorkspaceTrusted("/etc"),
    /outside the vidi-chat workspace root/
  );
  // The prefix-sibling must throw too — string-prefix containment would be a bug.
  assert.throws(
    () => markClaudeWorkspaceTrusted(WORKSPACE + "-evil"),
    /outside the vidi-chat workspace root/
  );
  // And nothing was written for the refused paths.
  assert.equal(fs.existsSync(claudeConfig), false);
});

test("markCodexWorkspaceTrusted refuses a path outside the workspace root", () => {
  assert.throws(
    () => markCodexWorkspaceTrusted(os.homedir()),
    /outside the vidi-chat workspace root/
  );
  assert.equal(fs.existsSync(codexConfig), false);
});

// --- claude: ~/.claude.json projects[<abs>].hasTrustDialogAccepted -----------

test("claude: creates the trust entry for the workspace root", () => {
  markClaudeWorkspaceTrusted(WORKSPACE);
  const cfg = readJson(claudeConfig);
  assert.equal(cfg.projects[wsReal].hasTrustDialogAccepted, true);
});

test("claude: is idempotent and preserves sibling projects + other keys", () => {
  // Seed unrelated global state + another project, then re-run.
  const cfg = readJson(claudeConfig);
  cfg.oauthAccount = { keep: "me" };
  cfg.projects["/some/other/project"] = { hasTrustDialogAccepted: false, extra: 1 };
  cfg.projects[wsReal].allowedTools = ["Read"]; // pre-existing sibling field
  fs.writeFileSync(claudeConfig, JSON.stringify(cfg, null, 2));

  markClaudeWorkspaceTrusted(WORKSPACE);
  const after = readJson(claudeConfig);
  assert.equal(after.projects[wsReal].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects[wsReal].allowedTools, ["Read"]); // field survived
  assert.deepEqual(after.oauthAccount, { keep: "me" }); // global state survived
  assert.equal(after.projects["/some/other/project"].extra, 1); // sibling survived
  assert.equal(after.projects["/some/other/project"].hasTrustDialogAccepted, false);
});

test("claude: an already-trusted entry is left byte-identical (no rewrite)", () => {
  const before = fs.readFileSync(claudeConfig, "utf8");
  markClaudeWorkspaceTrusted(WORKSPACE);
  assert.equal(fs.readFileSync(claudeConfig, "utf8"), before);
});

test("claude: honors an explicit config dir (per-account CLAUDE_CONFIG_DIR)", () => {
  const altDir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-alt-"));
  markClaudeWorkspaceTrusted(WORKSPACE, altDir);
  const alt = readJson(path.join(altDir, ".claude.json"));
  assert.equal(alt.projects[wsReal].hasTrustDialogAccepted, true);
});

test("claude: refuses to clobber a corrupted .claude.json", () => {
  const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-corrupt-"));
  const corruptPath = path.join(corruptHome, ".claude.json");
  fs.writeFileSync(corruptPath, "{ this is not json");
  markClaudeWorkspaceTrusted(WORKSPACE, corruptHome);
  // Untouched — the file is the CLI's/user's to repair.
  assert.equal(fs.readFileSync(corruptPath, "utf8"), "{ this is not json");
});

// --- codex: ~/.codex/config.toml [projects."<abs>"] trust_level -------------

test("codex: appends the trusted table, byte-preserving prior content", () => {
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  const prior =
    '# my codex config\nmodel = "gpt-5.6-luna"\n\n' +
    '[projects."/Users/someone/elsewhere"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(codexConfig, prior);

  markCodexWorkspaceTrusted(WORKSPACE);
  const after = fs.readFileSync(codexConfig, "utf8");
  assert.ok(after.startsWith(prior), "prior content must be preserved verbatim");
  assert.match(
    after,
    new RegExp(
      `\\[projects\\."${wsReal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\r?\\ntrust_level = "trusted"`
    )
  );
});

test("codex: is idempotent — a second call does not duplicate the table", () => {
  const before = fs.readFileSync(codexConfig, "utf8");
  markCodexWorkspaceTrusted(WORKSPACE);
  assert.equal(fs.readFileSync(codexConfig, "utf8"), before);
});

test("codex: does NOT override a pre-existing (even untrusted) table for the path", () => {
  const untrustHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-codex-"));
  const untrustPath = path.join(untrustHome, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(untrustPath), { recursive: true });
  const content = `[projects."${wsReal}"]\ntrust_level = "untrusted"\n`;
  fs.writeFileSync(untrustPath, content);
  markCodexWorkspaceTrusted(WORKSPACE, path.dirname(untrustPath));
  // A user's explicit untrust is respected, not flipped or duplicated.
  assert.equal(fs.readFileSync(untrustPath, "utf8"), content);
});

test("codex: creates config.toml from nothing when absent", () => {
  const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-trust-fresh-"));
  markCodexWorkspaceTrusted(WORKSPACE, path.join(freshHome, ".codex"));
  const created = fs.readFileSync(path.join(freshHome, ".codex", "config.toml"), "utf8");
  assert.match(created, /trust_level = "trusted"/);
});
