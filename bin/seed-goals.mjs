#!/usr/bin/env node
/**
 * seed-goals — write/refresh the three standing-goal DEFINITIONS in
 * data/goals.json. RUN MANUALLY, once, post-merge:
 *
 *   node bin/seed-goals.mjs
 *
 * This is deliberately NOT run by tests or the PR — it mutates the live
 * data/goals.json (a gitignored per-install file). It only carries the DATA
 * SHAPE of the owner's signed-off goals; the engine (lib/goals.ts) owns
 * behavior.
 *
 * Idempotent + non-clobbering. Merge is BY SLUG:
 *   - a slug not present is appended as a fresh active goal,
 *   - a slug already present has ONLY its definition fields updated (title,
 *     description, verifyCmd, rearmAfterHours, budget), while every RUNTIME field
 *     is preserved verbatim: id, status, lastTick, lastVerify, plan, checkpoints,
 *     createdAt. So running this twice, or over a goal that's mid-flight (active
 *     and looping, or done and re-arming), never duplicates it, never resets its
 *     status, and never drops its verify clock.
 *
 * verifyCmd paths are resolved relative to this script's own location (REPO,
 * below), never hardcoded to one install's absolute path.
 *
 * Dependency-free .mjs; reads VIDI_DATA_DIR else <repo>/data (lib/data-dir.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dataDir() {
  const override = process.env.VIDI_DATA_DIR;
  if (typeof override === "string" && override.trim()) return override.trim();
  return path.join(REPO, "data");
}
function goalsFile() {
  return path.join(dataDir(), "goals.json");
}

/**
 * The signed-off definitions. Only DEFINITION fields live here — no status, no
 * id, no clocks. The merge fills runtime fields for new goals and preserves them
 * for existing ones.
 */
const DEFS = [
  {
    slug: "vidi-chat-suite-health",
    title: "Keep the vidi-chat test suite green and growing",
    description:
      "Each tick: run the suite; if anything is red, fix it properly per spec. If green, add ONE meaningful test to the least-covered lib/ module (not a decorative assertion). Keep tsc clean.",
    verifyCmd: `cd ${REPO} && npm test`,
    rearmAfterHours: 168, // weekly re-verify
    budget: { maxIterations: 2, maxTicksPerDay: 2 },
  },
  {
    slug: "proactive-delivery-health",
    title: "Keep the daily greeting and evening wrap actually delivering",
    description:
      "Verify yesterday's morning greeting AND evening wrap actually delivered (spoken or push); if a day went silent, diagnose why and produce a fix or a filed finding. The verifyCmd is deterministic: it passes only when both ledgers show a terminal delivered channel for yesterday (quiet-suppressed counts as delivered on a deliberately quiet day).",
    verifyCmd: `node ${path.join(REPO, "bin/check-anticipation-delivery.mjs")}`,
    rearmAfterHours: 24, // daily
    budget: { maxIterations: 4, maxTicksPerDay: 1 },
  },
  {
    slug: "docs-truth",
    title: "Keep the plan and design docs true to repo/runtime reality",
    description:
      "Weekly: diff the repo's plan and design docs (README, docs/, any PLAN-*.md) against actual repo/runtime reality; fix drift by committing doc corrections. NOTE: verifyCmd is `true` on purpose — the goal's WORK is the verification (a human-judgment doc diff, not a deterministic gate), so re-arm just re-opens the review on cadence rather than proving a green check. Revisit if a deterministic drift-check ever exists.",
    verifyCmd: "true",
    rearmAfterHours: 168, // weekly
    budget: { maxIterations: 4, maxTicksPerDay: 1 },
  },
];

function readGoals() {
  try {
    const parsed = JSON.parse(fs.readFileSync(goalsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeGoals(goals) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = goalsFile();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(goals, null, 2));
  fs.renameSync(tmp, file);
}

/** True if applying `def`'s definition fields onto `existing` would change
 *  anything observable. Pure — no I/O, no Date.now() — so callers can decide
 *  whether updatedAt should move at all. Budget is compared by value, not
 *  reference, since seed always constructs a fresh object for it. */
function definitionChanged(existing, def) {
  return (
    existing.title !== def.title ||
    existing.description !== def.description ||
    existing.verifyCmd !== def.verifyCmd ||
    existing.rearmAfterHours !== def.rearmAfterHours ||
    existing.budget?.maxIterations !== def.budget.maxIterations ||
    existing.budget?.maxTicksPerDay !== def.budget.maxTicksPerDay
  );
}

/**
 * Merge DEFS into `goals` in place (mutates and also returns it for
 * convenience). `now` and `mkId` are injected so this is unit-testable without
 * touching Date.now()/Math.random() or the filesystem. Returns a per-slug
 * summary line for CLI output.
 *
 * updatedAt is bumped ONLY when a definition field actually changed — a no-op
 * re-run (running seed-goals twice back to back with no DEFS edits) leaves an
 * existing goal's updatedAt untouched, so it can't be mistaken for a fresh
 * mutation the tick/mirror needs to react to.
 */
function mergeGoals(goals, defs, now, mkId) {
  const summary = [];
  for (const def of defs) {
    const existing = goals.find((g) => g.slug === def.slug);
    if (existing) {
      if (definitionChanged(existing, def)) {
        existing.title = def.title;
        existing.description = def.description;
        existing.verifyCmd = def.verifyCmd;
        existing.rearmAfterHours = def.rearmAfterHours;
        existing.budget = { ...def.budget };
        existing.updatedAt = now;
        summary.push(`updated  ${def.slug} (status kept: ${existing.status})`);
      } else {
        summary.push(`unchanged ${def.slug} (status kept: ${existing.status})`);
      }
    } else {
      goals.push({
        id: mkId(),
        slug: def.slug,
        title: def.title,
        description: def.description,
        status: "active",
        budget: { ...def.budget },
        verifyCmd: def.verifyCmd,
        rearmAfterHours: def.rearmAfterHours,
        createdAt: now,
        updatedAt: now,
      });
      summary.push(`created  ${def.slug} (active)`);
    }
  }
  return summary;
}

function defaultMkId(now) {
  return `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function main() {
  const goals = readGoals();
  const now = Date.now();
  const summary = mergeGoals(goals, DEFS, now, () => defaultMkId(now));
  writeGoals(goals);
  process.stdout.write(
    ["seed-goals: wrote " + goalsFile(), ...summary.map((s) => "  " + s)].join("\n") + "\n"
  );
}

// Only run when invoked directly (`node bin/seed-goals.mjs`) — importing this
// module for its exports (the unit test does) must not have a side effect.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { mergeGoals, definitionChanged, DEFS, REPO };
