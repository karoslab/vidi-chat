import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Canvas visibility scoping (fix: fleet shows only user-initiated agents).
 *
 * An agent carries an `origin` — "chat"/"manual" are user-initiated and render
 * on the Canvas; "goal"/"system" are background autonomy and are excluded from
 * the panes, the "N active" count, AND the on-disk registry (so goal ticks
 * never accrete idle 0-turn cards). This exercises the manager seam directly:
 * no provider turn / CLI is spawned.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fleet-vis-test-")));
const store = await import("../lib/store.ts");
const {
  spawn,
  close,
  listAgents,
  listVisibleAgents,
  isUserVisibleOrigin,
  _internal,
} = await import("../lib/agents/manager.ts");

function agentsFile(): string {
  return path.join(process.cwd(), "data", "agents.json");
}
function readAgentsJson(): any[] {
  return JSON.parse(fs.readFileSync(agentsFile(), "utf8"));
}

test("isUserVisibleOrigin: only chat + manual are visible", () => {
  assert.equal(isUserVisibleOrigin("chat"), true);
  assert.equal(isUserVisibleOrigin("manual"), true);
  assert.equal(isUserVisibleOrigin("goal"), false);
  assert.equal(isUserVisibleOrigin("system"), false);
});

test("spawn defaults to manual origin and is visible", () => {
  const a = spawn({ provider: "claude", name: "Manualdefault" });
  assert.equal(a.origin, "manual");
  assert.ok(listVisibleAgents().some((x) => x.id === a.id));
  close(a.id);
});

test("chat-origin agent shows on the Canvas roster", () => {
  const a = spawn({ provider: "claude", name: "Chatty", origin: "chat" });
  assert.equal(a.origin, "chat");
  assert.ok(listVisibleAgents().some((x) => x.id === a.id));
  close(a.id);
});

test("goal/system agents run but are hidden from the Canvas roster + count", () => {
  const goalAgent = spawn({ provider: "claude", name: "Goalsuitehealth", origin: "goal" });
  const sysAgent = spawn({ provider: "claude", name: "Sibling", origin: "system" });
  // Both exist in the full (coordination) roster — they genuinely run.
  const allIds = listAgents().map((x) => x.id);
  assert.ok(allIds.includes(goalAgent.id));
  assert.ok(allIds.includes(sysAgent.id));
  // Neither appears on the Canvas-facing roster (nor the "N active" length).
  const visibleIds = listVisibleAgents().map((x) => x.id);
  assert.ok(!visibleIds.includes(goalAgent.id));
  assert.ok(!visibleIds.includes(sysAgent.id));
  close(goalAgent.id);
  close(sysAgent.id);
});

test("background agents are never persisted to agents.json (no accretion)", () => {
  const visible = spawn({ provider: "claude", name: "Keeper", origin: "manual" });
  const goalAgent = spawn({ provider: "claude", name: "Goaltransient", origin: "goal" });
  const rows = readAgentsJson();
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("Keeper")); // user agent persists
  assert.ok(!names.includes("Goaltransient")); // background agent does not
  // The persisted row carries the origin tag for future loads.
  assert.equal(rows.find((r) => r.name === "Keeper").origin, "manual");
  close(visible.id);
  close(goalAgent.id);
});

test("migration rule: legacy names infer the polluter origin", () => {
  const infer = _internal.inferLegacyOrigin;
  // Goal-tick agents: "goal-<slug>" sanitizes to "Goal<slug>" (>=6 trailing
  // letters, optional numeric dedupe suffix) — the ONLY inferred-hidden shape.
  assert.equal(infer("Goalvidichatsuitehealth"), "goal");
  assert.equal(infer("Goalvidichatsuitehealth3"), "goal");
  assert.equal(infer("Goalproactivedeliveryhealth"), "goal");
  assert.equal(infer("Goaldocstruth"), "goal");
  // QA fix (PR #48 review, defect): the old lc.startsWith("goal") check false-
  // hid a legacy user agent named "Goalie" (2 trailing letters, well short of
  // the goal-tick shape) — it must survive as manual.
  assert.equal(infer("Goalie"), "manual");
  // QA fix (PR #48 review, defect): a legacy Mahabharata fallback-pool callsign
  // is NO LONGER inferred "system" — those names were also handed to real
  // user-initiated pre-A3 spawns, so hiding on callsign alone risked hiding a
  // genuine user agent. The safe default is to show it.
  assert.equal(infer("Abhimanyu"), "manual");
  assert.equal(infer("Ghatotkacha"), "manual");
  // Any other real user-named agent stays visible.
  assert.equal(infer("Garuda"), "manual");
  assert.equal(infer("Zephyr"), "manual");
});

test("migration on load: polluted agents.json comes up clean on the Canvas", () => {
  // Craft four legacy rows (no origin field) backed by real threads so
  // loadFromDisk rehydrates them, then force a fresh load.
  const t1 = store.createThread("claude", "sonnet", "act");
  const t2 = store.createThread("claude", "sonnet", "act");
  const t3 = store.createThread("claude", "sonnet", "act");
  const t4 = store.createThread("claude", "sonnet", "act");
  const now = Date.now();
  const legacy = [
    { id: t1.id, name: "Goalvidichatsuitehealth3", provider: "claude", model: "sonnet", mode: "act", createdAt: now },
    // A legacy fallback-pool callsign row — must survive as visible (the defect
    // this migration test now guards against).
    { id: t2.id, name: "Ghatotkacha", provider: "claude", model: "sonnet", mode: "act", createdAt: now },
    { id: t3.id, name: "Garuda", provider: "claude", model: "sonnet", mode: "act", createdAt: now },
    // A short legacy name that merely starts with "goal" — must NOT be
    // swallowed by the goal-tick rule.
    { id: t4.id, name: "Goalie", provider: "claude", model: "sonnet", mode: "act", createdAt: now },
  ];
  fs.mkdirSync(path.dirname(agentsFile()), { recursive: true });
  fs.writeFileSync(agentsFile(), JSON.stringify(legacy, null, 2));

  // Reset the module's lazy-load latch so listAgents() re-reads the crafted file.
  const fleet = (globalThis as Record<string, any>).__vidiFleet;
  fleet.loaded = false;
  fleet.agents.clear();

  const all = listAgents().map((a) => ({ name: a.name, origin: a.origin }));
  assert.equal(all.length, 4); // all four rehydrate (they still run/coordinate)
  assert.equal(all.find((a) => a.name === "Goalvidichatsuitehealth3")?.origin, "goal");
  assert.equal(all.find((a) => a.name === "Ghatotkacha")?.origin, "manual");
  assert.equal(all.find((a) => a.name === "Garuda")?.origin, "manual");
  assert.equal(all.find((a) => a.name === "Goalie")?.origin, "manual");

  // Canvas comes up clean: the real/ambiguous user rows survive the filter,
  // only the deterministic goal-tick row is excluded.
  const visible = listVisibleAgents().map((a) => a.name).sort();
  assert.deepEqual(visible, ["Garuda", "Ghatotkacha", "Goalie"].sort());
});
