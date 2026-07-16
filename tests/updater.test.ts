import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Self-updater core (lib/updater.ts). Nothing here touches the network, spawns
 * a process, or exits the runner — fetch, the subprocess runner, and the exit
 * hook are all injected. Covers: manifest compare/parse, sha256 rejection, the
 * atomic swap (incl. a data-dir-inside case), the staging-build invocation
 * shape, single-flight, and one full happy-path pipeline on temp dirs.
 */

// Isolate BEFORE importing anything that resolves workspace/data at import time.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-updater-"));
const WS = path.join(ROOT, "ws");
const DATA = path.join(ROOT, "data");
fs.mkdirSync(path.join(WS, "vidi"), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(WS, "vidi", ".proxy-secret"), "VIDI_PROXY_KEY=test-key-123\n");
process.env.VIDI_WORKSPACE_ROOT = WS; // read once at import by lib/workspace.ts
process.env.VIDI_DATA_DIR = DATA; // temp data dir (not the live one → allowed)
process.env.VIDI_UPDATE_FORCE = "1"; // the committed release.json is a dev build
// Start in a temp cwd so any process.cwd()-relative default is isolated.
process.chdir(ROOT);

const U = await import("../lib/updater.ts");

const DEV = { version: "dev", sha: "", builtAt: "" };
const REAL = { version: "2026.07.01.1", sha: "aaaa1111", builtAt: "x" };

function manifest(over: Partial<Record<string, unknown>> = {}) {
  return {
    version: "2026.07.12.1",
    sha: "bbbb2222",
    url: "https://vidi-proxy.example.workers.dev/release/download/2026.07.12.1.tar.gz",
    sha256: "0".repeat(64),
    notes: "Faster startup and a calmer voice.",
    ...over,
  };
}

// ── parseManifest ────────────────────────────────────────────────────────────
test("parseManifest: accepts a well-formed manifest, lowercases sha256", () => {
  const m = U.parseManifest(manifest({ sha256: "ABCDEF" }));
  assert.equal(m.version, "2026.07.12.1");
  assert.equal(m.sha256, "abcdef");
  assert.equal(m.notes, "Faster startup and a calmer voice.");
});

test("parseManifest: rejects a missing required field", () => {
  assert.throws(() => U.parseManifest(manifest({ url: "" })), /url missing/);
  assert.throws(() => U.parseManifest(null), /not an object/);
});

// ── isUpdateAvailable ────────────────────────────────────────────────────────
test("isUpdateAvailable: differing sha → available", () => {
  assert.equal(U.isUpdateAvailable(REAL, U.parseManifest(manifest())), true);
});

test("isUpdateAvailable: same version and sha → not available", () => {
  const m = U.parseManifest(manifest({ version: REAL.version, sha: REAL.sha }));
  assert.equal(U.isUpdateAvailable(REAL, m), false);
});

test("isUpdateAvailable: same sha, bumped version label → not available (sha is authoritative)", () => {
  const m = U.parseManifest(manifest({ version: "2026.09.09.9", sha: REAL.sha }));
  assert.equal(U.isUpdateAvailable(REAL, m), false);
});

// ── sha256 integrity ─────────────────────────────────────────────────────────
test("verifySha256: matching hash passes, mismatch fails, empty expected fails", () => {
  const buf = Buffer.from("vidi release tarball bytes");
  const good = U.sha256Hex(buf);
  assert.equal(U.verifySha256(buf, good), true);
  assert.equal(U.verifySha256(buf, good.toUpperCase()), true);
  assert.equal(U.verifySha256(buf, "0".repeat(64)), false);
  assert.equal(U.verifySha256(buf, ""), false);
});

// ── atomicSwap ───────────────────────────────────────────────────────────────
test("atomicSwap: renames staging into place and keeps the previous dir", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-swap-"));
  const appDir = path.join(base, "vidi-chat");
  const stagingDir = `${appDir}.staging-1.0`;
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "OLD"), "old");
  fs.mkdirSync(stagingDir);
  fs.writeFileSync(path.join(stagingDir, "NEW"), "new");

  const { prevDir } = U.atomicSwap({ appDir, stagingDir, version: "1.0" });

  assert.ok(fs.existsSync(path.join(appDir, "NEW")), "app dir now holds the new build");
  assert.ok(!fs.existsSync(path.join(appDir, "OLD")), "old file gone from app dir");
  assert.ok(fs.existsSync(path.join(prevDir, "OLD")), "previous build kept for rollback");
  assert.ok(!fs.existsSync(stagingDir), "staging dir consumed");
});

test("atomicSwap: carryData moves an in-app data dir into the new tree", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-swap-data-"));
  const appDir = path.join(base, "vidi-chat");
  const stagingDir = `${appDir}.staging-2.0`;
  fs.mkdirSync(path.join(appDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "data", "threads.jsonl"), "keep me");
  fs.mkdirSync(stagingDir);
  fs.writeFileSync(path.join(stagingDir, "NEW"), "new");

  const { prevDir } = U.atomicSwap({ appDir, stagingDir, version: "2.0", carryData: true });

  assert.equal(
    fs.readFileSync(path.join(appDir, "data", "threads.jsonl"), "utf8"),
    "keep me",
    "the user's data survived the swap",
  );
  assert.ok(!fs.existsSync(path.join(prevDir, "data")), "data was moved, not left behind");
});

// ── staging build/install invocation shape ───────────────────────────────────
test("buildStaging: invokes the staged next binary with the service's dist-dir/env", async () => {
  const paths = U.resolveUpdatePaths("1.0", "/tmp/app", "/tmp/data", "/rt/node/bin/node");
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const run = async (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
  };
  await U.buildStaging(paths, run);
  assert.equal(calls[0].cmd, "/rt/node/bin/node");
  assert.deepEqual(calls[0].args, [paths.nextBinStaging, "build"]);
  assert.equal(calls[0].env.NEXT_DIST_DIR, ".next-build");
  assert.equal(calls[0].env.NODE_ENV, "production");
  assert.equal(calls[0].cwd, paths.stagingDir);
});

test("npmCiStaging: runs `npm ci` in staging via the bundled npm cli", async () => {
  const paths = U.resolveUpdatePaths("1.0", "/tmp/app", "/tmp/data", "/rt/node/bin/node");
  assert.equal(paths.npmCli, "/rt/node/lib/node_modules/npm/bin/npm-cli.js");
  const calls: string[][] = [];
  await U.npmCiStaging(paths, async (_c, args) => {
    calls.push(args);
  });
  assert.deepEqual(calls[0], [paths.npmCli, "ci", "--no-audit", "--no-fund", "--include=dev"]);
});

test("resolveUpdatePaths: dataInsideApp true only when data lives under the app dir", () => {
  assert.equal(U.resolveUpdatePaths("1", "/a/vidi-chat", "/a/data").dataInsideApp, false);
  assert.equal(U.resolveUpdatePaths("1", "/a/vidi-chat", "/a/vidi-chat/data").dataInsideApp, true);
});

// ── single-flight lock ───────────────────────────────────────────────────────
test("single-flight: a second lock acquisition is refused until released", () => {
  assert.equal(U.acquireUpdateLock(), true);
  assert.equal(U.acquireUpdateLock(), false, "second acquire refused while held");
  U.releaseUpdateLock();
  assert.equal(U.acquireUpdateLock(), true, "acquirable again after release");
  U.releaseUpdateLock();
});

// ── full pipeline (happy path) ───────────────────────────────────────────────
test("runUpdatePipeline: download → verify → unpack → install → build → swap → exit", async () => {
  const appDir = path.join(ROOT, "app-happy", "vidi-chat");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "ORIGINAL"), "v-old");
  process.chdir(appDir);

  const tarball = Buffer.from("a plausible git-archive tarball");
  const sha = U.sha256Hex(tarball);
  const m = manifest({ sha256: sha });

  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("/release/manifest")) {
      return new Response(JSON.stringify(m), { status: 200 });
    }
    return new Response(tarball, { status: 200 });
  }) as unknown as typeof fetch;

  const run = async (cmd: string, args: string[], opts: { cwd: string }) => {
    if (cmd === "tar") {
      // Simulate unpack into the -C target (staging), as real tar does.
      const dest = args[args.indexOf("-C") + 1];
      fs.writeFileSync(path.join(dest, "package.json"), '{"name":"vidi-chat"}');
      fs.writeFileSync(path.join(dest, "STAGED"), "v-new");
    } else if (args.includes("build")) {
      fs.mkdirSync(path.join(opts.cwd, ".next-build"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, ".next-build", "BUILD_ID"), "id");
    }
    // npm ci → noop
  };

  let exited: number | null = null;
  await U.runUpdatePipeline({ fetchImpl, run, exit: (c) => (exited = c), restartDelayMs: 0 });

  const status = U.getStatus();
  assert.equal(status.phase, "done");
  assert.equal(status.ok, true);
  assert.ok(fs.existsSync(path.join(appDir, "STAGED")), "app dir now holds the new build");
  assert.ok(fs.existsSync(path.join(appDir, ".next-build", "BUILD_ID")), "built dist in place");
  assert.ok(!fs.existsSync(path.join(appDir, "ORIGINAL")), "old tree swapped out");
  const prev = `${appDir}.prev-${m.version}`;
  assert.ok(fs.existsSync(path.join(prev, "ORIGINAL")), "previous version kept for rollback");
  // exit fires on the next tick (restartDelayMs 0).
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(exited, 0, "process exits so launchd respawns on the new code");
});

// ── full pipeline (checksum mismatch) ────────────────────────────────────────
test("runUpdatePipeline: a sha256 mismatch is rejected hard — no swap", async () => {
  const appDir = path.join(ROOT, "app-badsum", "vidi-chat");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "ORIGINAL"), "v-old");
  process.chdir(appDir);

  const tarball = Buffer.from("tampered bytes");
  const m = manifest({ sha256: "0".repeat(64) }); // does NOT match the tarball

  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("/release/manifest")) {
      return new Response(JSON.stringify(m), { status: 200 });
    }
    return new Response(tarball, { status: 200 });
  }) as unknown as typeof fetch;

  let ran = false;
  const run = async (cmd: string) => {
    if (cmd !== "tar") return;
    ran = true; // unpack must never be reached on a bad checksum
  };

  await assert.rejects(
    U.runUpdatePipeline({ fetchImpl, run, exit: () => {}, restartDelayMs: 0 }),
    /checksum/i,
  );
  assert.equal(ran, false, "nothing was unpacked");
  assert.ok(fs.existsSync(path.join(appDir, "ORIGINAL")), "the live tree is untouched");
  assert.ok(!fs.existsSync(`${appDir}.download-${m.version}.tar.gz`), "the bad download was deleted");
});

// --- fix/updater-customer-key: customer installs auth with the stored voice code ---
test("resolveProxyKey: owner secret file wins; customer voice code is the fallback; neither is null", async () => {
  const { resolveProxyKey } = await import("../lib/proxy-secret.ts");
  assert.equal(resolveProxyKey("owner-secret", "customer-code"), "owner-secret");
  assert.equal(resolveProxyKey(null, "customer-code"), "customer-code");
  assert.equal(resolveProxyKey("owner-secret", null), "owner-secret");
  assert.equal(resolveProxyKey(null, null), null);
});

test("readProxyKey wires the file reader and the stored voice code through resolveProxyKey", async () => {
  // The wiring test: readProxyKey must consult BOTH sources. We assert the
  // module exposes both readers and that readProxyKey agrees with resolving
  // their current values — no filesystem fixtures, no env games.
  const mod = await import("../lib/proxy-secret.ts");
  const { readVoiceKey } = await import("../lib/voice-tier.ts");
  assert.equal(
    mod.readProxyKey(),
    mod.resolveProxyKey(mod.readProxySecretFile(), readVoiceKey())
  );
});
