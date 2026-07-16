import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * agent.finished durable sink (W4): the manager appends one JSONL line per turn
 * completion (working→idle / working→error) to data/agents-transitions.jsonl —
 * the ONLY transition source the ops agent.finished producer can watermark off
 * (agents.json is just the static roster). We exercise the EXACT function
 * runTurn's finally-block calls (_internal.recordTransition) directly, so no
 * provider turn / CLI is spawned. The provider chain isn't importable under
 * `node --test` (extensionless "./claude" in providers/index.ts), which is why
 * the manager smoke test lives elsewhere and we test the sink at this seam.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-agent-transitions-")));
const { _internal } = await import("../lib/agents/manager.ts");

function transitionsPath(): string {
  return path.join(process.cwd(), "data", "agents-transitions.jsonl");
}
function readTransitions(): any[] {
  return fs
    .readFileSync(transitionsPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("records a working→idle transition with agentId, name, status, ts, summary", () => {
  _internal.recordTransition(
    { id: "agent-abc", name: "Turnia" },
    "idle",
    "Done — I fixed the failing test and pushed the branch."
  );
  const rows = readTransitions().filter((r) => r.agentId === "agent-abc");
  assert.equal(rows.length, 1);
  const t = rows[0];
  assert.equal(t.name, "Turnia");
  assert.equal(t.status, "idle");
  assert.ok(typeof t.ts === "number" && t.ts > 0);
  assert.match(t.summary, /I fixed the failing test/);
});

test("summary is capped at ~120 chars and whitespace-collapsed", () => {
  const long = "x ".repeat(200); // 400 chars with lots of whitespace
  _internal.recordTransition({ id: "agent-long", name: "Longy" }, "idle", long);
  const t = readTransitions().find((r) => r.agentId === "agent-long");
  assert.ok(t.summary.length <= 120, `summary length ${t.summary.length} <= 120`);
  assert.doesNotMatch(t.summary, /\s{2,}/, "whitespace collapsed");
});

test("an errored turn records status:error and an empty summary when no text", () => {
  _internal.recordTransition({ id: "agent-err", name: "Errora" }, "error");
  const t = readTransitions().find((r) => r.agentId === "agent-err");
  assert.equal(t.status, "error");
  assert.equal(t.summary, "");
});

test("append-only: multiple transitions accumulate, newest last", () => {
  _internal.recordTransition({ id: "agent-multi", name: "A" }, "idle", "first");
  _internal.recordTransition({ id: "agent-multi", name: "A" }, "idle", "second");
  const rows = readTransitions().filter((r) => r.agentId === "agent-multi");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].summary, "first");
  assert.equal(rows[1].summary, "second");
});

test("line shape is exactly what the ops agent.finished producer reads", () => {
  _internal.recordTransition({ id: "agent-shape", name: "Shapey" }, "idle", "ok");
  const t = readTransitions().find((r) => r.agentId === "agent-shape");
  // The producer keys on agentfin:<agentId>:<ts> and reads name/status/summary.
  assert.deepEqual(
    Object.keys(t).sort(),
    ["agentId", "name", "status", "summary", "ts"].sort()
  );
});
