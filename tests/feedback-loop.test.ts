import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Feedback route auth (requireWriteAuth) + no-key path + preview bundle content
 * (no secrets / paths). The route uses "@/" imports node --test can't resolve,
 * so we exercise the REAL guard (lib/origin.requireWriteAuth, driven by the real
 * control token) and the REAL lib functions the route calls.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-fb-loop-")));

const { requireWriteAuth } = await import("../lib/origin.ts");
const { getControlToken } = await import("../lib/control.ts");
const { recordDiag } = await import("../lib/diag-ledger.ts");
const {
  getInstallKey,
  hasInstallKey,
  sendFeedback,
  buildReportBundle,
  renderReportText,
} = await import("../lib/feedback.ts");

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:4183/api/feedback", {
    method: "POST",
    headers: { host: "localhost:4183", "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: "hi" }),
  });
}

test("requireWriteAuth: tokenless POST is 401, control-token POST passes", () => {
  const unauth = requireWriteAuth(req());
  assert.ok(unauth, "tokenless request rejected");
  assert.equal(unauth!.status, 401);

  const token = getControlToken();
  const authed = requireWriteAuth(req({ "x-vidi-control-token": token }));
  assert.equal(authed, null, "control token passes the write gate");
});

test("sendFeedback returns no-key when no install key is stored (no network)", async () => {
  assert.equal(hasInstallKey(), false);
  assert.equal(getInstallKey(), null);
  const result = await sendFeedback({ text: "hello", includeReport: false });
  assert.deepEqual(result, { ok: false, reason: "no-key" });
});

test("getInstallKey reads data/voice-key (today's source) once present", () => {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "data", "voice-key"), "vidi_live_testkey123\n");
  assert.equal(getInstallKey(), "vidi_live_testkey123");
  assert.equal(hasInstallKey(), true);
});

test("preview report bundle contains no secrets or paths (scrubbed by construction)", () => {
  const home = os.homedir();
  recordDiag("provider-fail", `crash at ${home}/Projects/secret.ts key sk-ABCDEFGHIJKLMNOPQRSTUV hash deadbeef0123456789ab`);
  const rendered = renderReportText(buildReportBundle());
  assert.ok(!rendered.includes(home), "no home dir");
  assert.ok(!rendered.includes("/Users/") && !rendered.includes("/home/"), "no absolute user paths");
  assert.ok(!/sk-ABCDEFGHIJKLMNOPQRSTUV/.test(rendered), "no api key");
  assert.ok(!/deadbeef0123456789ab/.test(rendered), "no hex run");
  // It should still be a useful report (counts + build).
  assert.ok(rendered.includes("App build:"), "report has the build line");
  assert.ok(/provider-fail/.test(rendered), "report keeps the category (safe)");
});
