import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate data/ per run (the module reads/writes data/accounts.json).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-accounts-test-")));

const {
  loadAccounts,
  getAccount,
  getActiveAccountId,
  getActiveAccount,
  setActiveAccountId,
  expandConfigDir,
  enabledAccounts,
} = await import("../lib/accounts.ts");

test("first load seeds the two-account registry to data/accounts.json", () => {
  const accounts = loadAccounts();
  assert.deepEqual(
    accounts.map((a) => a.id),
    ["main", "alt"]
  );
  assert.equal(accounts[0].configDir, null); // main = default account
  assert.equal(accounts[1].configDir, "~/.claude-profiles/alt");
  assert.ok(fs.existsSync(path.join(process.cwd(), "data", "accounts.json")));
});

test("active account defaults to the first registry entry when unset", () => {
  assert.equal(getActiveAccountId(), "main");
  assert.equal(getActiveAccount().id, "main");
});

test("setActiveAccountId persists a valid id and rejects an unknown one", () => {
  assert.equal(setActiveAccountId("alt"), true);
  assert.equal(getActiveAccountId(), "alt");
  assert.equal(getActiveAccount().id, "alt");
  assert.equal(setActiveAccountId("nope"), false);
  assert.equal(getActiveAccountId(), "alt"); // unchanged
});

test("getAccount looks up by id", () => {
  // The fresh-install seed uses a generic label — never the owner's handle.
  assert.equal(getAccount("main")?.label, "Default account");
  assert.equal(getAccount("ghost"), undefined);
});

test("expandConfigDir expands a leading ~ and passes null through", () => {
  assert.equal(expandConfigDir(null), null);
  assert.equal(expandConfigDir("~/.claude-profiles/alt"), path.join(os.homedir(), ".claude-profiles/alt"));
  assert.equal(expandConfigDir("/abs/path"), "/abs/path");
  assert.equal(expandConfigDir("~"), os.homedir());
});

test("a disabled account stays in the registry but is skipped everywhere", () => {
  // 2026-07-09: main's subscription lapsed — disable without removing.
  const registryPath = path.join(process.cwd(), "data", "accounts.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify(
      loadAccounts().map((a) => (a.id === "main" ? { ...a, disabled: true } : a)),
      null,
      2
    )
  );
  // Still IN the registry (visible, restorable)…
  assert.equal(getAccount("main")?.disabled, true);
  // …but out of the rotation pool…
  assert.deepEqual(enabledAccounts().map((a) => a.id), ["alt"]);
  // …a persisted active id pointing at it resolves to the first enabled…
  fs.writeFileSync(
    path.join(process.cwd(), "data", "active-account.json"),
    JSON.stringify({ id: "main" })
  );
  assert.equal(getActiveAccountId(), "alt");
  assert.equal(getActiveAccount().id, "alt");
  // …and it cannot be re-persisted as active while disabled (2026-07-05 lesson).
  assert.equal(setActiveAccountId("main"), false);
  assert.equal(setActiveAccountId("alt"), true);
});

test("enabledAccounts fails OPEN to the full registry when everything is disabled", () => {
  const registryPath = path.join(process.cwd(), "data", "accounts.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify(loadAccounts().map((a) => ({ ...a, disabled: true })), null, 2)
  );
  assert.deepEqual(enabledAccounts().map((a) => a.id), ["main", "alt"]);
});
