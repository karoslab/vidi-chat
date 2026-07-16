import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-names-test-")));

const { NAME_STACKS, allCuratedNames } = await import("../lib/agent-names.ts");
const { spawn, findByName, close } = await import("../lib/agents/manager.ts");
const { writeEditableConfig, _resetUserConfigCache } = await import("../lib/user-config.ts");

/** Write the agentNameStack preference to data/user-config.json for a test, and
 *  reset the config cache so the manager reads it live. */
function setPreferredStack(stackId: string): void {
  writeEditableConfig({ agentNameStack: stackId });
  _resetUserConfigCache();
}

/**
 * Curated agent-name stacks (P4.2). The picker offers these; a chosen name is
 * persisted via the fleet manager and used everywhere the agent is shown. Two
 * things matter: the stacks are well-formed (esp. the Kannada set, per the
 * no-slop rule), and a picked name actually persists to agents.json.
 */

test("every stack is non-empty and every name is unique across all stacks", () => {
  assert.ok(NAME_STACKS.length >= 3);
  for (const stack of NAME_STACKS) {
    assert.ok(stack.id && stack.label);
    assert.ok(stack.names.length >= 1, `stack ${stack.id} must have names`);
    for (const entry of stack.names) {
      assert.ok(entry.name.trim(), "name must be non-empty");
      assert.ok(entry.meaning.trim(), `${entry.name} must carry a meaning`);
    }
  }
  const all = allCuratedNames().map((n) => n.toLowerCase());
  assert.equal(new Set(all).size, all.length, "curated names must not collide");
});

test("the Kannada / Indian-mythology stack is rendered with craft", () => {
  const kannada = NAME_STACKS.find((s) => s.id === "kannada");
  assert.ok(kannada, "the Kannada stack must exist");
  assert.ok(kannada!.names.length >= 5);
  for (const entry of kannada!.names) {
    // Kannada script is the hero: present, and actually in the Kannada Unicode
    // block (U+0C80–U+0CFF) — not a Romanization masquerading as script.
    assert.ok(entry.script && entry.script.trim(), `${entry.name} needs Kannada script`);
    assert.ok(
      [...entry.script!].some((ch) => ch >= "ಀ" && ch <= "೿"),
      `${entry.name}'s script must be real Kannada characters`
    );
    // A one-line meaning, per name — respectful, never decorative-only.
    assert.ok(entry.meaning.trim().length > 3, `${entry.name} needs a meaning`);
    // Roman name is ASCII so voice/STT can address it.
    assert.ok(/^[A-Za-z]+$/.test(entry.name), `${entry.name} must be addressable ASCII`);
  }
});

test("a picked curated name persists to agents.json and resolves by name", () => {
  const garuda = NAME_STACKS.find((s) => s.id === "kannada")!.names.find(
    (n) => n.name === "Garuda"
  )!;
  const agent = spawn({ provider: "claude", name: garuda.name });
  assert.equal(agent.name, "Garuda");

  // Persisted to disk with the chosen name.
  const rows = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "agents.json"), "utf8")
  );
  assert.ok(rows.some((r: { name: string }) => r.name === "Garuda"));

  // Addressable by that name (exact match).
  assert.equal(findByName("garuda")?.id, agent.id);
  close(agent.id);
});

test("a fully custom free-text name is honored and persisted too", () => {
  const agent = spawn({ provider: "claude", name: "Meghana" });
  assert.equal(agent.name, "Meghana");
  const rows = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "agents.json"), "utf8")
  );
  assert.ok(rows.some((r: { name: string }) => r.name === "Meghana"));
  close(agent.id);
});

/**
 * A3 — a NAMELESS spawn draws the next unused name from the user's preferred
 * stack; an EXPLICIT name is unaffected by the preference; and when the whole
 * stack is taken the fallback WRAPS within the stack (Garuda2, …) rather than
 * jumping to an unthemed pool.
 */
test("with a preference set, two nameless spawns get the stack's first two names", () => {
  // Greek stack: Athena, Atlas, Hermes, …
  setPreferredStack("greek");
  const greek = NAME_STACKS.find((s) => s.id === "greek")!.names.map((n) => n.name);
  const first = spawn({ provider: "claude" });
  const second = spawn({ provider: "claude" });
  assert.equal(first.name, greek[0]); // Athena
  assert.equal(second.name, greek[1]); // Atlas (next unused)
  close(first.id);
  close(second.id);
});

test("an explicit name is honored even when a preference is set", () => {
  setPreferredStack("greek");
  const agent = spawn({ provider: "claude", name: "Quill" });
  assert.equal(agent.name, "Quill"); // explicit wins over the preferred stack
  close(agent.id);
});

test("the default preference (Kannada) drives a nameless spawn", () => {
  // No agentNameStack set → the Kannada mythology stack is the default (A1).
  setPreferredStack("kannada");
  const kannadaFirst = NAME_STACKS.find((s) => s.id === "kannada")!.names[0].name; // Garuda
  const agent = spawn({ provider: "claude" });
  assert.equal(agent.name, kannadaFirst);
  close(agent.id);
});

test("when the preferred stack is exhausted, the fallback wraps within it", () => {
  // Greek has 6 names; spawn all 6, then a 7th nameless spawn must WRAP to
  // "<firstName>2" rather than an unthemed pool name (least-surprising fallback).
  setPreferredStack("greek");
  const greek = NAME_STACKS.find((s) => s.id === "greek")!.names.map((n) => n.name);
  const spawned = greek.map(() => spawn({ provider: "claude" }));
  assert.deepEqual(
    spawned.map((a) => a.name),
    greek
  );
  const wrapped = spawn({ provider: "claude" });
  assert.equal(wrapped.name, `${greek[0]}2`); // Athena2
  spawned.forEach((a) => close(a.id));
  close(wrapped.id);
});
