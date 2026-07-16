import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// deferred-onboarding resolves data/ off process.cwd() at call time (shared
// dataDir()), so chdir into a fresh temp dir before importing — same isolation
// pattern as onboarding.test / intro-thread.test.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-deferred-test-")));

const {
  DEFERRABLE_STEPS,
  DEFERRED_STEP_META,
  readDeferredSteps,
  deferStep,
  resolveStep,
  clearDeferredSteps,
  stepsToClearOnFinish,
} = await import("../lib/deferred-onboarding.ts");

let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  });
}

function freshCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-deferred-"));
  process.chdir(dir);
  return dir;
}

serial("no file → nothing deferred", () => {
  freshCwd();
  assert.deepEqual(readDeferredSteps(), []);
});

serial("defer persists a step under dataDir() and reads back", () => {
  freshCwd();
  deferStep("security");
  assert.deepEqual(readDeferredSteps(), ["security"]);
  // Persisted under <cwd>/data (the shared dataDir()).
  assert.ok(fs.existsSync(path.join(process.cwd(), "data", "deferred-onboarding.json")));
});

serial("defer is idempotent (no duplicates)", () => {
  freshCwd();
  deferStep("name");
  deferStep("name");
  assert.deepEqual(readDeferredSteps(), ["name"]);
});

serial("multiple deferrals read back in canonical step order (not insertion order)", () => {
  freshCwd();
  deferStep("starters");
  deferStep("backends");
  deferStep("security");
  // Canonical order is DEFERRABLE_STEPS order, regardless of when each was filed.
  assert.deepEqual(readDeferredSteps(), ["backends", "security", "starters"]);
});

serial("resolve removes a finished step; others remain", () => {
  freshCwd();
  deferStep("backends");
  deferStep("intro");
  resolveStep("backends");
  assert.deepEqual(readDeferredSteps(), ["intro"]);
});

serial("clear empties the whole checklist", () => {
  freshCwd();
  deferStep("name");
  deferStep("permissions");
  clearDeferredSteps();
  assert.deepEqual(readDeferredSteps(), []);
});

serial("an unknown step is rejected (fixed-set guard — no arbitrary injection)", () => {
  freshCwd();
  deferStep("../../etc/passwd");
  deferStep("not-a-real-step");
  assert.deepEqual(readDeferredSteps(), []);
});

serial("a corrupt/garbage file reads as empty (fail-open)", () => {
  freshCwd();
  const file = path.join(process.cwd(), "data", "deferred-onboarding.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(readDeferredSteps(), []);
});

serial("a file with unknown values filters them out (fixed-set guard on read)", () => {
  freshCwd();
  const file = path.join(process.cwd(), "data", "deferred-onboarding.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(["security", "bogus", "intro", 42]));
  assert.deepEqual(readDeferredSteps(), ["security", "intro"]);
});

serial("every deferrable step has UI meta (label + blurb)", () => {
  for (const step of DEFERRABLE_STEPS) {
    const meta = DEFERRED_STEP_META[step];
    assert.ok(meta && meta.label.trim().length > 0 && meta.blurb.trim().length > 0);
  }
});

/**
 * FW4 — finish() must clear ONLY the steps actually completed in the run. The
 * bug: skipping the name step then skip-finishing at starters fired a blanket
 * clear that erased the just-filed "name" item.
 */
serial("stepsToClearOnFinish clears only completed steps; skipped items survive", () => {
  // Skip-everything run finished by SKIPPING starters: nothing completed, so
  // nothing is cleared — a deferred "name" (or any skipped step) survives.
  assert.deepEqual(stepsToClearOnFinish([], false), []);
  // Same run finished by the starters PRIMARY action: only starters clears.
  assert.deepEqual(stepsToClearOnFinish([], true), ["starters"]);
  // Completed backends + security, skipped name, finished via starters primary:
  // backends/security/starters clear; the skipped "name" is NOT in the list.
  assert.deepEqual(
    stepsToClearOnFinish(["security", "backends"], true),
    ["backends", "security", "starters"]
  );
  assert.equal(stepsToClearOnFinish(["security", "backends"], true).includes("name"), false);
  // Unknown ids are filtered; result is canonical-ordered and de-duped.
  assert.deepEqual(stepsToClearOnFinish(["bogus", "name", "name"], false), ["name"]);
});

serial("stepsToClearOnFinish, applied to a real checklist, spares a skipped item", () => {
  freshCwd();
  // The user skipped name (filed) and completed backends this run, then finished
  // via the starters primary action.
  deferStep("name");
  deferStep("backends"); // filed, but then completed this run
  for (const done of stepsToClearOnFinish(["backends"], true)) resolveStep(done);
  // backends + starters cleared; the skipped "name" item survives.
  assert.deepEqual(readDeferredSteps(), ["name"]);
});

/**
 * A2 — the "Name your helpers" step is a deferrable checklist item, ordered
 * AFTER the capabilities/permissions step and BEFORE the starters card, with
 * its own plain-language label + blurb, and it participates in the
 * completed-clears / skipped-survives bookkeeping like any other step.
 */
serial("helpers is a deferrable step ordered after permissions, before starters", () => {
  const order = DEFERRABLE_STEPS as readonly string[];
  assert.ok(order.includes("helpers"), "helpers must be deferrable");
  assert.ok(
    order.indexOf("helpers") > order.indexOf("permissions"),
    "helpers comes after permissions"
  );
  assert.ok(
    order.indexOf("helpers") < order.indexOf("starters"),
    "helpers comes before starters"
  );
  const meta = DEFERRED_STEP_META.helpers;
  assert.ok(meta.label.trim().length > 0 && meta.blurb.trim().length > 0);
});

serial("a skipped helpers step is filed and survives finishing at a later step", () => {
  freshCwd();
  deferStep("helpers"); // user skipped it
  // Finished via the starters primary action, having completed nothing else.
  for (const done of stepsToClearOnFinish([], true)) resolveStep(done);
  // starters cleared (it wasn't deferred); the skipped "helpers" survives.
  assert.deepEqual(readDeferredSteps(), ["helpers"]);
  // Later, completing helpers via its own primary action clears it.
  for (const done of stepsToClearOnFinish(["helpers"], false)) resolveStep(done);
  assert.deepEqual(readDeferredSteps(), []);
});
