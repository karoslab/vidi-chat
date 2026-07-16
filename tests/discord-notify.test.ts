import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Stage 5 — the Discord notification mirror. Isolated in a temp cwd so the
 * webhook record lands under <temp>/data, never the live data dir. The POST is
 * injected so no real network call is made.
 */
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-discord-test-"));
process.chdir(testCwd);

const {
  validateWebhookUrl,
  setWebhookUrl,
  clearWebhook,
  webhookReady,
  getWebhookConfig,
  sendPing,
  sendTestPing,
  WebhookValidationError,
} = await import("../lib/discord-notify.ts");

const WEBHOOK_FILE = path.join(testCwd, "data", "discord-webhook.json");
const GOOD = "https://discord.com/api/webhooks/123456789/abcDEF-ghi_JKL";

function reset() {
  try {
    fs.rmSync(WEBHOOK_FILE);
  } catch {
    /* not there yet */
  }
}

// Serialize — all cases share the one webhook record path (module-global).
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(fn);
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  });
}

serial("validateWebhookUrl accepts a real discord webhook, rejects everything else", () => {
  assert.equal(validateWebhookUrl(GOOD), null);
  assert.equal(validateWebhookUrl("https://ptb.discord.com/api/webhooks/1/xyz"), null);
  assert.equal(validateWebhookUrl("https://discord.com/api/v10/webhooks/1/xyz"), null);

  // Pasted the wrong thing entirely.
  assert.match(validateWebhookUrl("hello there")!, /doesn't look like a link/);
  // A discord link but not a webhook.
  assert.match(validateWebhookUrl("https://discord.com/channels/1/2")!, /isn't a Discord webhook/);
  // Right shape, wrong host.
  assert.match(validateWebhookUrl("https://evil.com/api/webhooks/1/xyz")!, /isn't a Discord webhook/);
  // Not https.
  assert.match(validateWebhookUrl("http://discord.com/api/webhooks/1/xyz")!, /https/);
  // Empty.
  assert.match(validateWebhookUrl("   ")!, /Paste the webhook link/);
  // No dashes in any customer-facing reason.
  for (const bad of ["hi", "https://discord.com/channels/1/2", "http://discord.com/api/webhooks/1/x"]) {
    assert.doesNotMatch(validateWebhookUrl(bad)!, /[–—]/);
  }
});

serial("setWebhookUrl throws WebhookValidationError on a bad url, nothing stored", () => {
  reset();
  assert.throws(() => setWebhookUrl("not a webhook"), WebhookValidationError);
  assert.equal(getWebhookConfig().configured, false);
});

serial("test-ping gate: verify() (webhookReady) passes only after a 2xx test ping", async () => {
  reset();
  // Store a valid URL — but it is NOT ready until the mandatory test ping passes.
  setWebhookUrl(GOOD);
  assert.equal(webhookReady(), false, "stored but untested must not be ready");

  // Failing test ping keeps it not-ready.
  const bad = await sendTestPing({ post: async () => ({ ok: false, status: 404 }) });
  assert.equal(bad.ok, false);
  assert.equal(webhookReady(), false, "failed test ping must not flip ready");

  // Successful 2xx test ping flips the gate.
  const good = await sendTestPing({ post: async () => ({ ok: true, status: 204 }) });
  assert.equal(good.ok, true);
  assert.equal(webhookReady(), true, "2xx test ping makes it ready");
  assert.equal(getWebhookConfig().lastTestPingOk, true);
});

serial("re-pasting a new url resets the gate (must be re-tested)", () => {
  reset();
  setWebhookUrl(GOOD);
  assert.equal(webhookReady(), false);
  // even after we would have tested, storing a fresh url clears lastTestPingOk
  setWebhookUrl("https://discord.com/api/webhooks/999/newtoken");
  assert.equal(getWebhookConfig().lastTestPingOk, false);
});

serial("sendPing is quiet by default: skips when nothing is configured", async () => {
  reset();
  const res = await sendPing("hello", { post: async () => ({ ok: true, status: 204 }) });
  assert.equal(res.skipped, true);
  assert.equal(res.ok, false);
});

serial("sendPing posts the content to the stored webhook when configured", async () => {
  reset();
  setWebhookUrl(GOOD);
  let sentTo: string | null = null;
  let sentBody: any = null;
  const res = await sendPing("work is live", {
    post: async (url, body) => {
      sentTo = url;
      sentBody = body;
      return { ok: true, status: 204 };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(sentTo, GOOD);
  assert.deepEqual(sentBody, { content: "work is live" });
});

serial("sendPing never throws on a network error", async () => {
  reset();
  setWebhookUrl(GOOD);
  const res = await sendPing("x", {
    post: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /network down/);
});

serial("clearWebhook disconnects (skip path)", async () => {
  reset();
  setWebhookUrl(GOOD);
  clearWebhook();
  assert.equal(getWebhookConfig().configured, false);
  assert.equal(webhookReady(), false);
});
