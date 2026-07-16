import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  claudeEffort,
  clampEffort,
  effortRank,
  normalizeEffort,
  normalizeMode,
  resolveRun,
} from "../lib/models.ts";

/**
 * The router reads data/model-availability.json in cwd. Tests pin the cache
 * (fresh verdict) before resolving so no background probe — which spawns a
 * real claude CLI turn — ever fires from the test suite.
 */
const CACHE = path.join(process.cwd(), "data", "model-availability.json");

function pinFable(available: boolean) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const prior = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, "utf8") : null;
  fs.writeFileSync(
    CACHE,
    JSON.stringify({ fableAvailable: available, checkedAt: Date.now(), source: "probe" })
  );
  return () => {
    if (prior === null) fs.rmSync(CACHE, { force: true });
    else fs.writeFileSync(CACHE, prior);
  };
}

test("legacy modes normalize: chat→plan, act→auto", () => {
  assert.equal(normalizeMode("chat"), "plan");
  assert.equal(normalizeMode("act"), "auto");
  assert.equal(normalizeMode("plan"), "plan");
  assert.equal(normalizeMode("auto"), "auto");
  assert.equal(normalizeMode(undefined), "plan");
});

test("effort normalizes over the six-level ladder with medium default (FIX 6)", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
    assert.equal(normalizeEffort(e), e);
  }
  assert.equal(normalizeEffort("bogus"), "medium");
  assert.equal(normalizeEffort(undefined), "medium");
});

test("effort ladder ranking + clamp (FIX 6)", () => {
  assert.ok(
    effortRank("low") < effortRank("medium") &&
      effortRank("medium") < effortRank("high") &&
      effortRank("high") < effortRank("xhigh") &&
      effortRank("xhigh") < effortRank("max") &&
      effortRank("max") < effortRank("ultra")
  );
  // clamp never goes UP: below/at ceiling passes; above ceiling clamps down.
  assert.equal(clampEffort("high", "max"), "high");
  assert.equal(clampEffort("ultra", "max"), "max");
  assert.equal(clampEffort("max", "xhigh"), "xhigh");
  assert.equal(clampEffort("low", "xhigh"), "low");
});

test("claudeEffort clamps to claude's max ceiling: xhigh accepted, ultra→max (FIX 6)", () => {
  // claude --help: low, medium, high, xhigh, max (no ultra).
  assert.equal(claudeEffort("low"), "low");
  assert.equal(claudeEffort("medium"), "medium");
  assert.equal(claudeEffort("high"), "high");
  assert.equal(claudeEffort("xhigh"), "xhigh");
  assert.equal(claudeEffort("max"), "max");
  assert.equal(claudeEffort("ultra"), "max");
});

test("router: only the top 'ultra' dial fans out; build execution stays on sonnet at the requested effort (2026-07-12)", () => {
  const restore = pinFable(true);
  try {
    // Build/auto mode: every effort BELOW the top runs on sonnet with NO
    // ultracode keyword — the dial is honored, not overridden to a fan-out.
    for (const e of ["low", "medium", "high", "xhigh", "max"]) {
      const r = resolveRun({ model: "auto", mode: "auto", effort: e });
      assert.equal(r.model, "sonnet", `${e} → sonnet (execution)`);
      assert.equal(r.ultracode, false, `${e} → no ultracode`);
    }
    // Only the explicit top "Ultracode" tier fans out: opus orchestrator + keyword.
    const ultra = resolveRun({ model: "auto", mode: "auto", effort: "ultra" });
    assert.equal(ultra.model, "opus");
    assert.equal(ultra.ultracode, true);
    assert.equal(ultra.cliEffort, "max");
    // The requested effort reaches the CLI (xhigh/max stay).
    assert.equal(resolveRun({ model: "auto", mode: "auto", effort: "xhigh" }).cliEffort, "xhigh");
    assert.equal(resolveRun({ model: "auto", mode: "auto", effort: "max" }).cliEffort, "max");
  } finally {
    restore();
  }
});

test("auto routing: plan → deep model (opus), build → sonnet, and the dial is never overridden to ultracode", () => {
  const restore = pinFable(true);
  try {
    // Plan/reasoning → the deep model. Medium is HONORED and ultracode is
    // FALSE (the exact bug: a Medium plan reply was being forced to ultracode).
    const plan = resolveRun({ model: "auto", mode: "plan", effort: "medium" });
    assert.deepEqual(
      { m: plan.model, e: plan.cliEffort, uc: plan.ultracode },
      { m: "opus", e: "medium", uc: false }
    );
    // The top "Ultracode" tier is the only fan-out.
    const ultra = resolveRun({ model: "auto", mode: "auto", effort: "ultra" });
    assert.deepEqual(
      { m: ultra.model, e: ultra.cliEffort, uc: ultra.ultracode },
      { m: "opus", e: "max", uc: true }
    );
    // Build/execution → sonnet at the requested effort, no fan-out.
    const med = resolveRun({ model: "auto", mode: "auto", effort: "medium" });
    assert.deepEqual(
      { m: med.model, e: med.cliEffort, uc: med.ultracode },
      { m: "sonnet", e: "medium", uc: false }
    );
    const low = resolveRun({ model: "auto", mode: "auto", effort: "low" });
    assert.deepEqual(
      { m: low.model, e: low.cliEffort, uc: low.ultracode },
      { m: "sonnet", e: "low", uc: false }
    );
    // High effort in BUILD mode is still sonnet execution (not opus) — execution
    // is always sonnet unless the user asks for the top Ultracode fan-out.
    const high = resolveRun({ model: "auto", mode: "auto", effort: "high" });
    assert.deepEqual(
      { m: high.model, uc: high.ultracode },
      { m: "sonnet", uc: false }
    );
  } finally {
    restore();
  }
});

test("effort dial follows the tier: a deep turn with NO explicit effort defaults to high", () => {
  const restore = pinFable(true);
  try {
    // Plan mode, effort unspecified → opus at "high" (planning/review reasons
    // hard by default), ultracode FALSE (only the explicit top tier fans out).
    const plan = resolveRun({ model: "auto", mode: "plan" });
    assert.deepEqual(
      { m: plan.model, e: plan.cliEffort, uc: plan.ultracode },
      { m: "opus", e: "high", uc: false }
    );
    // An explicit effort on a deep turn still WINS over the tier default.
    assert.equal(resolveRun({ model: "auto", mode: "plan", effort: "medium" }).cliEffort, "medium");
    assert.equal(resolveRun({ model: "auto", mode: "plan", effort: "low" }).cliEffort, "low");
    // An explicit/legacy "fable" pick with no effort also gets the high deep
    // default (and degrades to opus while Fable is unavailable).
    assert.equal(resolveRun({ model: "fable" }).cliEffort, "high");
    assert.equal(resolveRun({ model: "fable" }).model, "opus");
    // A MECHANICAL (sonnet) turn with no explicit effort keeps the "medium"
    // default — the deep-high default must not bleed into shallow work.
    const shallow = resolveRun({ model: "auto", mode: "auto" });
    assert.deepEqual(
      { m: shallow.model, e: shallow.cliEffort, uc: shallow.ultracode },
      { m: "sonnet", e: "medium", uc: false }
    );
  } finally {
    restore();
  }
});

test("fable is retired: deep turns and explicit/pinned fable become opus + ultracode", () => {
  const restore = pinFable(false);
  try {
    const plan = resolveRun({ model: "auto", mode: "plan", effort: "medium" });
    assert.deepEqual(
      { model: plan.model, uc: plan.ultracode },
      { model: "opus", uc: false }
    );
    // An explicit "fable" pick / stored thread pin resolves to opus while Fable
    // is unavailable — never a 400 or a dead model. No forced ultracode.
    const explicit = resolveRun({ model: "fable", mode: "auto", effort: "low" });
    assert.deepEqual(
      { model: explicit.model, uc: explicit.ultracode },
      { model: "opus", uc: false }
    );
    // Shallow non-deep turns still route to sonnet.
    const med = resolveRun({ model: "auto", mode: "auto", effort: "medium" });
    assert.deepEqual({ m: med.model, uc: med.ultracode }, { m: "sonnet", uc: false });
  } finally {
    restore();
  }
});

test("explicit model picks are honored (fable pins degrade to opus while Fable is unavailable)", () => {
  const restore = pinFable(true);
  try {
    // An explicit model pick is respected even in plan mode; the effort dial
    // still drives the fan-out keyword (only the top "ultra" tier sets it).
    assert.equal(resolveRun({ model: "sonnet", mode: "plan", effort: "ultra" }).model, "sonnet");
    assert.equal(resolveRun({ model: "sonnet", mode: "plan", effort: "ultra" }).ultracode, true);
    assert.equal(resolveRun({ model: "opus", mode: "plan", effort: "low" }).model, "opus");
    assert.equal(resolveRun({ model: "opus", mode: "plan", effort: "low" }).ultracode, false);
    // A pinned "fable" degrades to opus while Fable is unavailable; no forced
    // ultracode (a low dial stays a low, non-fan-out turn).
    const f = resolveRun({ model: "fable", mode: "auto", effort: "low" });
    assert.equal(f.model, "opus");
    assert.equal(f.ultracode, false);
  } finally {
    restore();
  }
});
