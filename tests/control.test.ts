import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-control-test-")));
const { getControlToken, verifyControlToken } = await import("../lib/control.ts");
const { remember, recall, memoryDigest } = await import("../lib/memory.ts");
const { startTerminal, listTerminals, tailTerminal, stopTerminal } = await import(
  "../lib/terminals.ts"
);

test("control token is stable and file-persisted with 0600", () => {
  const a = getControlToken();
  const b = getControlToken();
  assert.equal(a, b);
  assert.ok(a.length >= 20);
  const stat = fs.statSync(path.join(process.cwd(), "data", "control-token"));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("verifyControlToken accepts the right header, rejects others", () => {
  const tok = getControlToken();
  const mk = (h?: string) =>
    new Request("http://localhost/api/control", { headers: h ? { "x-vidi-control-token": h } : {} });
  assert.equal(verifyControlToken(mk(tok)), true);
  assert.equal(verifyControlToken(mk("wrong")), false);
  assert.equal(verifyControlToken(mk()), false);
});

test("shared memory remember/recall/digest", () => {
  remember("deploy window is 5pm", "Skye", ["ops"]);
  remember("demo-app build is green", "Marshall");
  assert.equal(recall().length, 2);
  assert.equal(recall("demo-app").length, 1);
  assert.equal(recall("ops").length, 1); // matches tag
  const digest = memoryDigest();
  assert.match(digest, /deploy window/);
  // H9: fleet memory is now fenced as untrusted and author-tagged. A
  // non-"vidi" author shows as "agent-authored: <name>".
  assert.match(digest, /agent-authored: Skye/);
  assert.match(digest, /DATA ONLY/);
});

test("managed terminal runs detached, logs, and stops", async () => {
  const term = startTerminal("echo vidi-terminal-ok");
  assert.ok(term.id);
  assert.ok(term.pid > 0);
  assert.equal(listTerminals().length, 1);
  // give the detached echo a moment to write its logfile
  await new Promise((r) => setTimeout(r, 300));
  assert.match(tailTerminal(term.id), /vidi-terminal-ok/);
  assert.equal(stopTerminal(term.id), true);
  assert.equal(listTerminals().length, 0);
});
