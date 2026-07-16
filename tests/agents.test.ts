import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-agents-test-")));
const { spawn, listAgents, findByName, close, subscribe, prompt } = await import(
  "../lib/agents/manager.ts"
);
const { matchFleetIntent } = await import("../lib/agents/intents.ts");

test("spawn assigns distinct pool names and persists", () => {
  const a = spawn({ provider: "claude" });
  const b = spawn({ provider: "codex" });
  assert.notEqual(a.name, b.name);
  assert.equal(a.provider, "claude");
  assert.equal(a.mode, "act"); // claude fleet agents build
  assert.equal(b.provider, "codex");
  assert.equal(b.mode, "chat"); // codex is read-only
  assert.equal(listAgents().length, 2);
  // persisted to data/agents.json
  const rows = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "agents.json"), "utf8"));
  assert.equal(rows.length, 2);
});

test("explicit name is honored and normalized", () => {
  const a = spawn({ provider: "claude", name: "zephyr" });
  assert.equal(a.name, "Zephyr");
  close(a.id);
});

test("findByName is exact-first with safe unique long-prefix only", () => {
  const a = spawn({ provider: "claude", name: "Quill" }); // unique, avoids pool collisions
  assert.equal(findByName("quill")?.id, a.id);
  assert.equal(findByName("QUILL")?.id, a.id);
  assert.equal(findByName("quil")?.id, a.id); // 4-char unique prefix
  assert.equal(findByName("nonexistent-xyz"), null);
  // The old hijack: a longer word that merely STARTS WITH the name must NOT
  // resolve (reversed prefix + edit-distance were removed).
  assert.equal(findByName("quillette-report-generator"), null);
  close(a.id);
});

test("findByName rejects short prefixes that would collide", () => {
  const a = spawn({ provider: "claude", name: "Ada" });
  // "administrator" starts with "ada" — must NOT resolve to Ada (the bug).
  assert.equal(findByName("administrator"), null);
  // sub-4-char query never prefix-matches
  assert.equal(findByName("ad"), null);
  assert.equal(findByName("ada")?.id, a.id); // exact still works
  close(a.id);
});

test("prompt() rejects a second concurrent turn synchronously (TOCTOU guard)", () => {
  const a = spawn({ provider: "claude", name: "Racer" });
  // First prompt claims the working slot synchronously (before any await).
  const first = prompt(a.id, "do a thing");
  assert.equal(first.ok, true);
  // Second prompt in the same tick must be rejected, not double-run.
  const second = prompt(a.id, "do another thing");
  assert.equal(second.ok, false);
  assert.match(second.reason || "", /still working/);
  close(a.id); // aborts the (never-really-started) background turn
});

test("duplicate explicit names get a numeric suffix", () => {
  const a = spawn({ provider: "claude", name: "Echo" });
  const b = spawn({ provider: "claude", name: "Echo" });
  assert.equal(a.name, "Echo");
  assert.equal(b.name, "Echo2");
  close(a.id);
  close(b.id);
});

test("close removes the agent, frees the name, and emits", () => {
  let closed = false;
  const unsub = subscribe((e) => {
    if (e.kind === "close") closed = true;
  });
  const a = spawn({ provider: "claude", name: "Rubble" });
  const before = listAgents().length;
  assert.equal(close(a.id), true);
  assert.equal(listAgents().length, before - 1);
  assert.equal(closed, true);
  assert.equal(findByName("Rubble"), null);
  // name is now reusable
  const b = spawn({ provider: "claude", name: "Rubble" });
  assert.equal(b.name, "Rubble");
  close(b.id);
  unsub();
});

test("fleet intent grammar", () => {
  assert.deepEqual(matchFleetIntent("vidi, spawn a claude agent"), {
    kind: "spawn",
    provider: "claude",
    name: undefined,
  });
  assert.deepEqual(matchFleetIntent("open a codex agent named skye"), {
    kind: "spawn",
    provider: "codex",
    name: "skye",
  });
  assert.deepEqual(matchFleetIntent("launch a claude code agent"), {
    kind: "spawn",
    provider: "claude",
    name: undefined,
  });
  assert.deepEqual(matchFleetIntent("ask Skye to run the tests"), {
    kind: "ask",
    name: "skye",
    task: "run the tests",
  });
  assert.deepEqual(matchFleetIntent("tell marshall the build is broken"), {
    kind: "ask",
    name: "marshall",
    task: "the build is broken",
  });
  assert.deepEqual(matchFleetIntent("close agent marshall"), { kind: "close", name: "marshall" });
  assert.deepEqual(matchFleetIntent("dismiss the agent skye"), { kind: "close", name: "skye" });
  // "agent" is optional (spoken form): safety lives in the handler — a
  // captured name that isn't a live agent falls through to a normal turn.
  assert.deepEqual(matchFleetIntent("close probe"), { kind: "close", name: "probe" });
  assert.deepEqual(matchFleetIntent("close the browser"), { kind: "close", name: "browser" });
  assert.deepEqual(matchFleetIntent("dismiss the notification"), { kind: "close", name: "notification" });
  assert.equal(matchFleetIntent("fleet status")?.kind, "status");
  assert.equal(matchFleetIntent("what are the agents doing")?.kind, "status");
  // non-fleet transcripts fall through
  assert.equal(matchFleetIntent("what is the weather today"), null);
  assert.equal(matchFleetIntent("summarize the demo-app repo"), null);
});

test("macro (teach-by-demonstration) intents", () => {
  assert.deepEqual(matchFleetIntent("watch this as deploy flow"), {
    kind: "macroRecord",
    name: "deploy flow",
  });
  assert.deepEqual(matchFleetIntent("watch this and call it standup"), {
    kind: "macroRecord",
    name: "standup",
  });
  assert.deepEqual(matchFleetIntent("watch this"), { kind: "macroRecord", name: "quicksave" });
  assert.equal(matchFleetIntent("stop watching")?.kind, "macroStop");
  assert.equal(matchFleetIntent("save the macro")?.kind, "macroStop");
  assert.equal(matchFleetIntent("what can you do")?.kind, "macroList");
  assert.deepEqual(matchFleetIntent("run the deploy routine"), {
    kind: "macroPlay",
    name: "deploy",
  });
  assert.deepEqual(matchFleetIntent("play standup"), { kind: "macroPlay", name: "standup" });
  // macroPlay is broad ("do X") on purpose — the handler resolves against
  // saved macros and returns null (fall-through) when none matches.
  assert.equal(matchFleetIntent("do the dishes")?.kind, "macroPlay");
});
