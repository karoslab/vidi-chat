import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// model-policy reads data/user-config.json under the cwd's data dir. Isolate cwd
// to a fresh temp dir before importing so a "fresh install" (no file, no env) is
// the baseline (same pattern as store.test.ts / policy.test.ts).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-model-policy-")));
const {
  DEFAULT_MODEL_POLICY,
  getModelPolicy,
  workerModelFor,
  workerEffort,
} = await import("../lib/model-policy.ts");

const POLICY_ENV = [
  "VIDI_DEEP_MODEL",
  "VIDI_DEEP_EFFORT",
  "VIDI_WORKER_MODEL",
  "VIDI_WORKER_CODEX_MODEL",
  "VIDI_WORKER_EFFORT",
];

function clearEnv() {
  for (const k of POLICY_ENV) delete process.env[k];
}

/** Write a data/user-config.json under the current cwd with the given modelPolicy
 *  (or arbitrary content), returning a restore fn. */
function writeConfig(content: unknown): () => void {
  const file = path.join(process.cwd(), "data", "user-config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return () => {
    if (prior === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, prior);
  };
}

test("fresh install (no env, no file) gets the shipped token-discipline policy", () => {
  clearEnv();
  const p = getModelPolicy();
  assert.deepEqual(p, {
    deepModel: "auto",
    deepEffort: "high",
    workerModelClaude: "sonnet",
    workerModelCodex: "gpt-5.5",
    workerEffort: "medium",
  });
  // The exported default mirrors it exactly.
  assert.deepEqual(p, DEFAULT_MODEL_POLICY);
});

test("worker defaults: claude → sonnet, codex → cheapest gpt slug, at medium", () => {
  clearEnv();
  assert.equal(workerModelFor("claude"), "sonnet");
  assert.equal(workerModelFor("codex"), "gpt-5.5");
  // A non-fleet-spawnable provider falls back to the claude worker model.
  assert.equal(workerModelFor("grok"), "sonnet");
  assert.equal(workerEffort(), "medium");
});

test("env override wins and is validated against the catalog allowlist", () => {
  clearEnv();
  process.env.VIDI_WORKER_MODEL = "opus";
  process.env.VIDI_WORKER_CODEX_MODEL = "gpt-5.6-luna";
  process.env.VIDI_WORKER_EFFORT = "low";
  process.env.VIDI_DEEP_EFFORT = "max";
  try {
    const p = getModelPolicy();
    assert.equal(p.workerModelClaude, "opus");
    assert.equal(p.workerModelCodex, "gpt-5.6-luna");
    assert.equal(p.workerEffort, "low");
    assert.equal(p.deepEffort, "max");
  } finally {
    clearEnv();
  }
});

test("read-time defense: a bogus env value is silently dropped to the default", () => {
  clearEnv();
  process.env.VIDI_WORKER_MODEL = "not-a-model";
  process.env.VIDI_WORKER_EFFORT = "turbo";
  process.env.VIDI_DEEP_EFFORT = "";
  try {
    const p = getModelPolicy();
    assert.equal(p.workerModelClaude, "sonnet"); // dropped → default
    assert.equal(p.workerEffort, "medium"); // dropped → default
    assert.equal(p.deepEffort, "high"); // blank → default (NOT normalizeEffort's "medium")
  } finally {
    clearEnv();
  }
});

test("data/user-config.json modelPolicy overrides the default (env absent)", () => {
  clearEnv();
  const restore = writeConfig({
    displayName: "Maya",
    modelPolicy: { workerModelClaude: "opus", workerEffort: "high", deepEffort: "xhigh" },
  });
  try {
    const p = getModelPolicy();
    assert.equal(p.workerModelClaude, "opus");
    assert.equal(p.workerEffort, "high");
    assert.equal(p.deepEffort, "xhigh");
    // Un-set fields still take the shipped default.
    assert.equal(p.workerModelCodex, "gpt-5.5");
    assert.equal(p.deepModel, "auto");
  } finally {
    restore();
  }
});

test("env beats the file; a bad file value falls back to the default", () => {
  clearEnv();
  process.env.VIDI_WORKER_MODEL = "sonnet";
  const restore = writeConfig({
    modelPolicy: { workerModelClaude: "opus", workerModelCodex: "bogus-slug" },
  });
  try {
    const p = getModelPolicy();
    assert.equal(p.workerModelClaude, "sonnet"); // env wins over the file's "opus"
    assert.equal(p.workerModelCodex, "gpt-5.5"); // file's bogus slug dropped → default
  } finally {
    restore();
    clearEnv();
  }
});

test("a corrupt user-config.json never throws — policy falls back to defaults", () => {
  clearEnv();
  const restore = writeConfig("{ this is not json");
  try {
    assert.deepEqual(getModelPolicy(), DEFAULT_MODEL_POLICY);
  } finally {
    restore();
  }
});
