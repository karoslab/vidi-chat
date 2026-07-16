import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The two new standing-report probes (W1): tailscale reachability and
 * push-transport health. Both must degrade to a plain finding, never throw —
 * that's what keeps the morning brief speakable when a probe fails.
 *
 * pushTransportHealth reads data/journal.jsonl off process.cwd(), so isolate
 * cwd into a fresh temp dir BEFORE importing (same pattern as phone-token /
 * push-route tests, which also pin cwd-relative paths at module load).
 */
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-standing-report-test-")));
const { tailscaleStatus, setTailscaleBin, pushTransportHealth, loadOpsConfig, gatherStandingReport } =
  await import("../lib/standing-report.ts");
const { appendJournal } = await import("../lib/journal.ts");
const { WORKSPACE_ROOT } = await import("../lib/workspace.ts");

test("tailscale probe degrades to 'not installed' when the CLI is absent", async () => {
  // The real machine has no tailscale yet; force it explicitly so the test is
  // deterministic even if it gets installed later.
  setTailscaleBin("/nonexistent/definitely-no-tailscale-here");
  const line = await tailscaleStatus();
  assert.equal(line, "tailscale: not installed");
});

test("tailscale probe reports backend + peers when the CLI answers", async () => {
  // Stub the CLI with a script that prints a fixed `status --json` payload
  // regardless of args, so we exercise the parse/format path without a daemon.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-tailscale-stub-"));
  const stub = path.join(dir, "tailscale");
  const payload = {
    BackendState: "Running",
    Self: { DNSName: "mymac.tailnet.ts.net." },
    Peer: { a: {}, b: {} },
  };
  fs.writeFileSync(
    stub,
    `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`,
    { mode: 0o755 }
  );
  setTailscaleBin(stub);
  const line = await tailscaleStatus();
  assert.equal(line, "tailscale: Running (mymac.tailnet.ts.net), 2 peers");
});

test("tailscale probe never throws on garbage output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-tailscale-junk-"));
  const stub = path.join(dir, "tailscale");
  fs.writeFileSync(stub, `#!/bin/sh\necho 'not json at all'\n`, { mode: 0o755 });
  setTailscaleBin(stub);
  const line = await tailscaleStatus();
  assert.equal(line, "tailscale: running (unparseable status)");
});

test("push health reports 'no attempts' with an empty journal", () => {
  assert.equal(pushTransportHealth(), "discord: no push attempts recorded");
});

test("push health reports the latest outcome and a recent-delivered ratio", () => {
  // Journal is newest-LAST on disk; readJournal reverses it, so the last line
  // written is the latest attempt. Write one FAILED then one delivered.
  appendJournal({ ts: 1000, threadId: "push", tool: "Push.toPhone", summary: "[high FAILED] alert" });
  appendJournal({ ts: 2000, threadId: "push", tool: "Push.toPhone", summary: "[default] all clear" });
  const line = pushTransportHealth();
  assert.match(line, /^discord: last delivered at /);
  // 2 attempts this run, 1 failed → 1/2 delivered.
  assert.match(line, /\(1\/2 recent delivered\)/);
  assert.ok(line.includes(new Date(2000).toISOString()));
});

test("push health surfaces a FAILED latest attempt", () => {
  // Newest write wins as "latest": append a failure last.
  appendJournal({ ts: 3000, threadId: "push", tool: "Push.toPhone", summary: "[urgent FAILED] boom" });
  const line = pushTransportHealth();
  assert.match(line, /^discord: last FAILED at /);
});

/**
 * Ops portfolio is config-driven (VIDI_OPS_CONFIG) so no install-specific
 * service list / DB paths ship in source. With no config the report degrades
 * HONESTLY; a valid config supplies the portfolio; a corrupt one fails soft.
 */
test("loadOpsConfig returns an empty portfolio when VIDI_OPS_CONFIG is unset", () => {
  delete process.env.VIDI_OPS_CONFIG;
  const cfg = loadOpsConfig();
  assert.deepEqual(cfg.services, []);
  assert.equal(cfg.deployGuardDb, null);
  assert.equal(cfg.nightshiftDir, null);
});

test("loadOpsConfig parses services and resolves paths (relative → under workspace, absolute → as-is)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ops-config-"));
  const file = path.join(dir, "ops.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      services: [
        { name: "svc-a", url: "http://localhost:9101/" },
        { name: "svc-b", url: "http://localhost:9102/health" },
        { name: "bad", url: 123 }, // wrong type → dropped
      ],
      deployGuardDb: "sub/dir/guard.db", // relative
      nightshiftDir: "/abs/nightshift", // absolute
    })
  );
  process.env.VIDI_OPS_CONFIG = file;
  try {
    const cfg = loadOpsConfig();
    assert.deepEqual(cfg.services, [
      { name: "svc-a", url: "http://localhost:9101/" },
      { name: "svc-b", url: "http://localhost:9102/health" },
    ]);
    assert.equal(cfg.deployGuardDb, path.join(WORKSPACE_ROOT, "sub/dir/guard.db"));
    assert.equal(cfg.nightshiftDir, "/abs/nightshift");
  } finally {
    delete process.env.VIDI_OPS_CONFIG;
  }
});

test("loadOpsConfig fails soft to an empty portfolio on a corrupt / missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ops-config-bad-"));
  const file = path.join(dir, "ops.json");
  fs.writeFileSync(file, "{ not valid json ");
  process.env.VIDI_OPS_CONFIG = file;
  try {
    assert.deepEqual(loadOpsConfig(), { services: [], deployGuardDb: null, nightshiftDir: null });
    // A path that doesn't exist is equally fail-soft.
    process.env.VIDI_OPS_CONFIG = path.join(dir, "does-not-exist.json");
    assert.deepEqual(loadOpsConfig(), { services: [], deployGuardDb: null, nightshiftDir: null });
  } finally {
    delete process.env.VIDI_OPS_CONFIG;
  }
});

test("gatherStandingReport reports the honest 'not configured' lines with no ops config", async () => {
  delete process.env.VIDI_OPS_CONFIG;
  setTailscaleBin("/nonexistent/definitely-no-tailscale-here"); // keep it network-free + deterministic
  const report = await gatherStandingReport();
  assert.match(report, /SERVICES: no services configured/);
  assert.match(report, /DEPLOY GUARD \(latest verdict per project\): deploy guard: not configured/);
  assert.match(report, /NIGHTSHIFT LATEST: \(NightShift not configured\)/);
});
