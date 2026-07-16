import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataDir, dataPath } from "../lib/data-dir.ts";

/**
 * T1.6 — VIDI_DATA_DIR override. Unset → <cwd>/data (byte-identical to before,
 * so every existing data/ writer and its tests are unchanged). Set → the whole
 * install points at that dir, so a fresh-install rehearsal can run against an
 * empty temp dir without touching real data (Phase 0 step 6 / P4.4).
 */

// Isolate cwd into a temp dir up front. The byte-identity assertions below test
// dataDir() === <cwd>/data with VIDI_DATA_DIR unset — a property that holds for
// ANY cwd — but under VIDI_TEST=1 the live-data guard (added 2026-07-07) would
// throw if that cwd were the repo root. chdir-ing to a temp dir keeps the
// property meaningful AND clear of the guard. The dedicated guard test at the
// bottom juggles cwd itself.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-datadir-cwd-")));

test("unset VIDI_DATA_DIR resolves to <cwd>/data", () => {
  delete process.env.VIDI_DATA_DIR;
  assert.equal(dataDir(), path.join(process.cwd(), "data"));
  assert.equal(dataPath("threads"), path.join(process.cwd(), "data", "threads"));
});

test("VIDI_DATA_DIR overrides the base dir", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-datadir-"));
  process.env.VIDI_DATA_DIR = temp;
  try {
    assert.equal(dataDir(), temp);
    assert.equal(dataPath("onboarded.json"), path.join(temp, "onboarded.json"));
  } finally {
    delete process.env.VIDI_DATA_DIR;
  }
});

test("a blank/whitespace override falls back to <cwd>/data", () => {
  process.env.VIDI_DATA_DIR = "   ";
  try {
    assert.equal(dataDir(), path.join(process.cwd(), "data"));
  } finally {
    delete process.env.VIDI_DATA_DIR;
  }
});

/**
 * FW5 — full VIDI_DATA_DIR isolation. Every data/ writer/reader in lib/ and
 * app/ now resolves through dataPath()/dataDir(). The HARD CONSTRAINT: with
 * VIDI_DATA_DIR unset, each resolved path must be BYTE-IDENTICAL to the old
 * `path.join(process.cwd(), "data", <name>)`. This asserts it for a
 * representative sample of the actual filenames the migrated modules use — the
 * shared helper is the single seam, so byte-identity here proves it for every
 * consumer.
 */
test("FW5 — unset VIDI_DATA_DIR resolves every migrated path byte-identically", () => {
  delete process.env.VIDI_DATA_DIR;
  const legacy = (...segs: string[]) => path.join(process.cwd(), "data", ...segs);
  // One representative filename per migrated module (the exact strings passed to
  // dataPath in each): confirm, push, kill, quiet, phone-token, control, quota,
  // memory, terminals, hands, overlay, brain, journal, accounts, models,
  // agents/manager, events, policy, commitments, voice-fleet, goals.
  const samples: string[][] = [
    ["pending-action.json"],
    ["ntfy-topic"],
    ["KILL"],
    ["quiet.json"],
    ["phone-token"],
    ["control-token"],
    ["quota.jsonl"],
    ["memory.jsonl"],
    ["terminals"],
    ["hands-token"],
    ["overlay-config.json"],
    ["last-ingest-trigger"],
    ["journal.jsonl"],
    ["accounts.json"],
    ["active-account.json"],
    ["model-availability.json"],
    ["agents.json"],
    ["agents-transitions.jsonl"],
    ["events"],
    ["events", "spoken-ledger.jsonl"],
    ["events", "queued.jsonl"],
    ["commitments.jsonl"],
    ["sentry-transcripts"],
    ["goals.json"],
    ["goals", "some-slug", "plan.md"],
  ];
  for (const segs of samples) {
    assert.equal(dataPath(...segs), legacy(...segs), `mismatch for ${segs.join("/")}`);
  }
  // The data dir base itself (goals.ts's dataDir(), preamble's default) is unchanged.
  assert.equal(dataDir(), path.join(process.cwd(), "data"));
});

test("with VIDI_DATA_DIR pointed at an empty dir, the install reads as a FRESH install", async () => {
  // The onboarding gate (isOnboarded) reads threads + the flag from the data
  // dir. Point it at an empty temp dir → not onboarded → the first-run flow
  // shows. This is exactly what the rehearsal needs.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fresh-"));
  process.env.VIDI_DATA_DIR = temp;
  try {
    // No cache-buster needed: onboarding's gate functions resolve dataDir() at
    // CALL time (onboardedFlagPath()/threadsDir()/profilePath() are lazy), so a
    // plain import re-reads the freshly-set VIDI_DATA_DIR. The query-string spec
    // was the only thing tsc couldn't resolve (TS2307) — dropping it fixes tsc
    // while keeping the assertion identical.
    const { isOnboarded, readProfile } = await import("../lib/onboarding.ts");
    assert.equal(isOnboarded(), false);
    assert.equal(readProfile(), null);
  } finally {
    delete process.env.VIDI_DATA_DIR;
  }
});

/**
 * Live-data guard (2026-07-07). A test that forgets to isolate — no
 * VIDI_DATA_DIR, cwd at the repo root — must FAIL LOUDLY instead of silently
 * writing the real data/ dir (which once got polluted with commitments/quota
 * fixtures). The guard is gated on VIDI_TEST=1 (set by the npm test script).
 */
test("guard: dataDir() throws if a test would resolve the LIVE repo data dir", () => {
  // The repo root is this test file's parent-of-parent (tests/ → repo). That is
  // exactly what lib/data-dir.ts computes ../data against, so chdir-ing here
  // makes the cwd fallback equal the guarded live dir.
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const priorCwd = process.cwd();
  const priorDataDir = process.env.VIDI_DATA_DIR;
  const priorSentinel = process.env.VIDI_TEST;
  process.chdir(repoRoot);
  delete process.env.VIDI_DATA_DIR;
  process.env.VIDI_TEST = "1";
  try {
    assert.throws(() => dataDir(), /must never use the live data dir/);
    // dataPath() flows through dataDir(), so it is guarded too.
    assert.throws(() => dataPath("commitments.jsonl"), /live data dir/);
  } finally {
    process.chdir(priorCwd);
    if (priorDataDir === undefined) delete process.env.VIDI_DATA_DIR;
    else process.env.VIDI_DATA_DIR = priorDataDir;
    if (priorSentinel === undefined) delete process.env.VIDI_TEST;
    else process.env.VIDI_TEST = priorSentinel;
  }
});

test("guard: an explicit VIDI_DATA_DIR override is never blocked by the guard", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const priorCwd = process.cwd();
  const priorDataDir = process.env.VIDI_DATA_DIR;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-guard-override-"));
  process.chdir(repoRoot); // even at the repo root...
  process.env.VIDI_DATA_DIR = temp; // ...an explicit override wins, no throw.
  process.env.VIDI_TEST = "1";
  try {
    assert.equal(dataDir(), temp);
  } finally {
    process.chdir(priorCwd);
    if (priorDataDir === undefined) delete process.env.VIDI_DATA_DIR;
    else process.env.VIDI_DATA_DIR = priorDataDir;
  }
});

/**
 * Regression — the sandbox VIDI_DATA_DIR pin (2026-07-07). The act-mode provider
 * pins VIDI_DATA_DIR = dataDir() (the LIVE data dir) into every Bash child
 * (lib/providers/claude.ts). A `node --test` run inside that sandbox inherited
 * the live dir through dataDir()'s override branch, bypassed the cwd-fallback
 * guard, and every forgot-to-isolate test wrote real data/. This proves an
 * inherited pin at the live dir is now rejected — an in-sandbox suite run can no
 * longer touch live data. Complements the `npm test` env -u strip (asserted below).
 */
test("guard: an INHERITED VIDI_DATA_DIR pointed at the LIVE data dir is rejected (sandbox pin)", () => {
  const liveData = path.resolve(import.meta.dirname, "..", "data");
  const priorCwd = process.cwd();
  const priorDataDir = process.env.VIDI_DATA_DIR;
  const priorSentinel = process.env.VIDI_TEST;
  // cwd is irrelevant here — the override branch fires regardless — but keep it
  // in a temp dir so the assertion is about the override, not the fallback.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-sandbox-pin-")));
  process.env.VIDI_TEST = "1";
  try {
    // Exact live dir, and a non-normalized variant (trailing slash) — path.resolve
    // must normalize both to the guarded dir so no formatting slips past.
    for (const pin of [liveData, liveData + path.sep, path.join(liveData, ".", "")]) {
      process.env.VIDI_DATA_DIR = pin;
      assert.throws(() => dataDir(), /live data dir/, `pin not rejected: ${pin}`);
      assert.throws(() => dataPath("commitments.jsonl"), /live data dir/);
    }
  } finally {
    process.chdir(priorCwd);
    if (priorDataDir === undefined) delete process.env.VIDI_DATA_DIR;
    else process.env.VIDI_DATA_DIR = priorDataDir;
    if (priorSentinel === undefined) delete process.env.VIDI_TEST;
    else process.env.VIDI_TEST = priorSentinel;
  }
});

/**
 * Regression — the primary defense: the `npm test` script must strip an inherited
 * VIDI_DATA_DIR (env -u) before node starts, so the sandbox pin never reaches the
 * suite at all (the guard above is the backstop for a raw `node --test`). Assert
 * the script statically so a future edit can't silently drop the strip.
 */
test("npm test script strips an inherited VIDI_DATA_DIR (env -u) and keeps the VIDI_TEST sentinel", () => {
  const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const testScript = pkg.scripts?.test ?? "";
  assert.match(
    testScript,
    /env -u VIDI_DATA_DIR/,
    "test script must strip an inherited VIDI_DATA_DIR before node starts"
  );
  assert.match(
    testScript,
    /VIDI_TEST=1/,
    "test script must still set the VIDI_TEST sentinel that arms the live-data guard"
  );
});
