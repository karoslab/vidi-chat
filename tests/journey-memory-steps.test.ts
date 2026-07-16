import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-step-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-step-ws-"));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-step-data-"));
process.env.HOME = HOME;
process.env.VIDI_WORKSPACE_ROOT = WS;
process.env.VIDI_DATA_DIR = DATA;

const M = await import("../lib/memory-wiki.ts");
const steps = await import("../lib/journey/steps/memory.ts");

function cleanAll() {
  fs.rmSync(M.wikiRoot(), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, "journey-memory.json"), { force: true });
}

function noteArray(n: number) {
  return async () =>
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        slug: `s${i}`,
        title: `T${i}`,
        body: `body ${i} [[s${(i + 1) % n}]]`,
      }))
    );
}

test("all three steps are Stage 3 and carry the expected ids", () => {
  assert.deepEqual(
    steps.memorySteps.map((s) => [s.id, s.stage]),
    [
      ["memory-wiki", 3],
      ["memory-interview", 3],
      ["memory-bring-stuff", 3],
    ]
  );
});

test("every step carries the UI fields the shared StepFrame consumes", () => {
  for (const step of steps.memorySteps) {
    assert.equal(typeof step.why, "string", `${step.id} has a why`);
    assert.equal(typeof step.outcome, "string", `${step.id} has an outcome`);
    assert.ok(step.primaryAction, `${step.id} has a primaryAction`);
    assert.equal(step.primaryAction?.href, `/setup/step/${step.id}`);
  }
});

test("verify() never throws, even when the underlying state read blows up", async () => {
  cleanAll();
  M.scaffoldWiki();
  // Corrupt the state file so JSON.parse would throw if it weren't caught deep
  // inside readMemoryState AND at the step's own try/catch boundary.
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "journey-memory.json"), "{not json");
  for (const step of steps.memorySteps) {
    await assert.doesNotReject(() => step.verify());
  }
});

test("memoryWikiStep.verify scaffolds and passes on a fresh install", async () => {
  cleanAll();
  const r = await steps.memoryWikiStep.verify();
  assert.equal(r.ok, true);
  assert.equal(M.verifyWiki().ok, true);
});

test("memoryInterviewStep.verify: fails before the interview, passes after", async () => {
  cleanAll();
  M.scaffoldWiki();
  const before = await steps.memoryInterviewStep.verify();
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.fixStepId, "memory-interview");

  await M.runInterview({ who_you_are: "a tester" }, noteArray(15));
  const after = await steps.memoryInterviewStep.verify();
  assert.equal(after.ok, true);
});

test("memoryBringStuffStep.verify always passes (optional step)", async () => {
  cleanAll();
  M.scaffoldWiki();
  const none = await steps.memoryBringStuffStep.verify();
  assert.equal(none.ok, true);
  if (none.ok) assert.match(none.note ?? "", /any time later/i);

  const src = path.join(HOME, "brought");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "a.md"), "content");
  await M.ingestFolder(src, noteArray(3));
  const some = await steps.memoryBringStuffStep.verify();
  assert.equal(some.ok, true);
  if (some.ok) assert.match(some.note ?? "", /brought in/i);
});
