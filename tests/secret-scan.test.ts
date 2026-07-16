import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { scanText, scanTreeForSecrets, describeFindings } = await import("../lib/secret-scan.ts");

test("blocks a PEM private key and reports its line", () => {
  const text = ["# my notes", "hello", "-----BEGIN OPENSSH PRIVATE KEY-----", "abcd", "-----END-----"].join("\n");
  const f = scanText(text, "notes.md");
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 3);
  assert.equal(f[0].kind, "private-key");
  assert.match(f[0].message, /password or key/i);
});

test("blocks an AWS access key id", () => {
  const f = scanText("aws_key = AKIAIOSFODNN7EXAMPLE", "x.txt");
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "aws-key");
});

test("blocks GitHub, OpenAI, Slack, Google, Stripe token shapes", () => {
  assert.equal(scanText("ghp_" + "a".repeat(36))[0]?.kind, "github-token");
  assert.equal(scanText("github_pat_" + "a".repeat(30))[0]?.kind, "github-token");
  assert.equal(scanText("sk-ant-" + "a".repeat(20))[0]?.kind, "api-key");
  assert.equal(scanText("xoxb-123456789012-abcdefghijkl")[0]?.kind, "api-key");
  assert.equal(scanText("AIza" + "a".repeat(35))[0]?.kind, "api-key");
  assert.equal(scanText("sk_live_" + "a".repeat(24))[0]?.kind, "api-key");
});

test("blocks a labelled secret assignment", () => {
  assert.equal(scanText("password: hunter2isareallylongpw")[0]?.kind, "labelled-secret");
  assert.equal(scanText('client_secret="abcd1234efgh5678"')[0]?.kind, "labelled-secret");
});

test("blocks a .env-style UPPER_SNAKE secret line", () => {
  assert.equal(scanText("API_TOKEN=abcdef0123456789abcdef")[0]?.kind, "env-secret");
  assert.equal(scanText("export DATABASE_PASSWORD=s3cretVALUE9placeholder")[0]?.kind, "env-secret");
});

test("does NOT block ordinary prose or short values", () => {
  assert.equal(scanText("The quick brown fox jumped over the lazy dog.").length, 0);
  assert.equal(scanText("TITLE=Hello there friend").length, 0); // uppercase key, prose value
  assert.equal(scanText("port = 8080").length, 0);
  assert.equal(scanText("I remembered to buy milk and eggs today.").length, 0);
});

test("scanTreeForSecrets walks a folder, skips .git, reports relative paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-scan-"));
  fs.mkdirSync(path.join(root, "notes"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "notes", "clean.md"), "just a normal memory note");
  fs.writeFileSync(path.join(root, "notes", "leak.md"), "AWS_SECRET=AKIAIOSFODNN7EXAMPLE");
  // A secret hidden in .git must be ignored (git plumbing is never pushed content we scan).
  fs.writeFileSync(path.join(root, ".git", "config"), "ghp_" + "a".repeat(36));
  const findings = scanTreeForSecrets(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, path.join("notes", "leak.md"));
});

test("describeFindings names files in customer words with no dashes", () => {
  const msg = describeFindings([
    { file: "notes/leak.md", line: 1, kind: "aws-key", message: "x" },
  ]);
  assert.match(msg, /password or key/i);
  assert.match(msg, /notes\/leak\.md/);
  assert.doesNotMatch(msg, /[—–]/); // no em/en dashes in customer copy
});

test("describeFindings stays dash-free across every findings-file-count branch", () => {
  // The 0 / 1 / 2 / 3+ file branches are separate string-building paths in
  // describeFindings — check each one, not just the single-file case above.
  const finding = (file: string) => ({ file, line: 1, kind: "aws-key", message: "x" });
  assert.equal(describeFindings([]), "");
  assert.doesNotMatch(describeFindings([finding("a.md"), finding("b.md")]), /[—–]/);
  assert.doesNotMatch(
    describeFindings([finding("a.md"), finding("b.md"), finding("c.md"), finding("d.md")]),
    /[—–]/
  );
});

test("every message scanText() itself produces is dash-free customer copy", () => {
  // Covers the CUSTOMER_MESSAGE constant at its actual call site (scanText),
  // not just describeFindings' derived summary.
  const findings = scanText("AKIAIOSFODNN7EXAMPLE\n" + "ghp_" + "a".repeat(36), "leak.env");
  assert.ok(findings.length >= 2);
  for (const f of findings) assert.doesNotMatch(f.message, /[—–]/);
});
