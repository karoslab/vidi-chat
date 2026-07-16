import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 4a — H10. (1) Spawn-depth: a spawned agent (depth>=1) cannot spawn
 * further agents — the advisory is now a hard mechanism. (2) File-mode: data/
 * PII files are written 0600 and data/ is 0700.
 */

// Isolate cwd so agents.json + data/ writes land in a throwaway dir.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-h10-")));

const { spawn, close, getAgent } = await import("../lib/agents/manager.ts");
const { secureDataFile, dataPath } = await import("../lib/data-dir.ts");

test("a user/top-level spawn is depth 0", () => {
  const a = spawn({ provider: "claude", name: "Root" });
  assert.equal(getAgent(a.id)!.depth, 0);
  close(a.id);
});

test("a depth-0 agent's spawn produces a depth-1 child", () => {
  const parent = spawn({ provider: "claude", name: "Parent" });
  const child = spawn({ provider: "claude", name: "Child", parentAgentId: parent.id });
  assert.equal(getAgent(child.id)!.depth, 1);
  close(parent.id);
  close(child.id);
});

test("a depth-1 agent CANNOT spawn (hard refuse)", () => {
  const root = spawn({ provider: "claude", name: "Root2" });
  const mid = spawn({ provider: "claude", name: "Mid", parentAgentId: root.id });
  assert.equal(getAgent(mid.id)!.depth, 1);
  assert.throws(
    () => spawn({ provider: "claude", name: "TooDeep", parentAgentId: mid.id }),
    /can't spawn further agents/i,
    "a depth-1 agent's spawn must be refused"
  );
  close(root.id);
  close(mid.id);
});

test("an unknown parent id is refused (can't hide lineage to get depth 0)", () => {
  assert.throws(
    () => spawn({ provider: "claude", name: "Sneaky", parentAgentId: "no-such-agent" }),
    /can't spawn further agents/i
  );
});

test("secureDataFile writes 0600 file mode and 0700 data/ (H10)", () => {
  const file = dataPath("journal.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  secureDataFile(file);

  // 0600 on the file (owner rw only). Mask to the permission bits.
  const fileMode = fs.statSync(file).mode & 0o777;
  assert.equal(fileMode, 0o600, `file mode should be 0600, got ${fileMode.toString(8)}`);

  // 0700 on data/.
  const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
  assert.equal(dirMode, 0o700, `data/ mode should be 0700, got ${dirMode.toString(8)}`);
});
