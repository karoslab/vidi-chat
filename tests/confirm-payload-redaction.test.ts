import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P8 finding 4 (P7 re-audit) — the confirm-payload exfil gap. A parked confirm
 * action's `payload` (an email body, a write-file's content, a calendar summary)
 * is dispatched to its executor after a human approves a short spoken/visual
 * DESCRIPTION — the full body is never surfaced at approval. So an act-mode
 * agent that read a live secret could smuggle it into the unshown body and
 * exfiltrate it past the "yes" (gws-email → Google, write-file → disk).
 * confirmPending() now runs redactSecretsDeep() over the payload before the
 * executor sees it. These tests pin:
 *   1. redactSecretsDeep scrubs strings at any depth, leaves benign text +
 *      non-strings intact;
 *   2. a registry executor receives a REDACTED payload from confirmPending,
 *      while benign fields (recipient, subject) are untouched.
 */

// Isolate data/ + seed own tokens BEFORE importing the libs (dataDir is
// call-time, but seed first so the own-token redaction layer has a value).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-redact-"));
process.chdir(tmp);
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
const OWN_CONTROL = "aVeryLongMachineLocalControlTokenValue999";
fs.writeFileSync(path.join(tmp, "data", "control-token"), OWN_CONTROL + "\n");

const { redactSecretsDeep } = await import("../lib/redact.ts");
const { fileConfirm, confirmPending, registerExecutor } = await import(
  "../lib/confirm.ts"
);

test("redactSecretsDeep scrubs strings at any depth, keeps benign + non-strings", () => {
  const input = {
    to: "mom@example.com",
    subject: "hi",
    body: "here is the key sk-ant-abcdefghij1234567890 you asked for",
    count: 3,
    flag: true,
    nested: { note: "Authorization: Bearer abcDEF1234567890xyz", ok: null },
    list: ["plain", `token ${OWN_CONTROL}`],
  };
  const out = redactSecretsDeep(input);
  assert.equal(out.to, "mom@example.com", "recipient untouched");
  assert.equal(out.subject, "hi", "subject untouched");
  assert.ok(!out.body.includes("sk-ant-abcdefghij"), "sk- key scrubbed from body");
  assert.equal(out.count, 3, "numbers pass through");
  assert.equal(out.flag, true, "booleans pass through");
  assert.equal(out.nested.ok, null, "null passes through");
  assert.match(out.nested.note, /Bearer \[REDACTED\]/, "nested Bearer scrubbed, label kept");
  assert.equal(out.list[0], "plain", "benign array item untouched");
  assert.ok(!out.list[1].includes(OWN_CONTROL), "own control token scrubbed from array");
});

test("confirmPending dispatches a REDACTED payload to the executor", async () => {
  let seen: any = null;
  registerExecutor("p8-redact-probe", async (payload) => {
    seen = payload;
    return "ok";
  });

  const nonce = fileConfirm({
    kind: "p8-redact-probe",
    description: "send a note",
    payload: {
      to: "mom@example.com",
      body: `secret is sk-ant-abcdefghij1234567890 and control ${OWN_CONTROL}`,
    },
  }).nonce;

  const res = await confirmPending(Date.now(), { nonce });
  assert.equal(res.ran, true, "the action ran");
  assert.ok(seen, "executor received a payload");
  assert.equal(seen.to, "mom@example.com", "benign recipient preserved");
  assert.ok(!seen.body.includes("sk-ant-abcdefghij"), "the smuggled sk- key was redacted pre-dispatch");
  assert.ok(!seen.body.includes(OWN_CONTROL), "the smuggled own control token was redacted pre-dispatch");
  assert.match(seen.body, /\[REDACTED\]/, "redaction marker present, text still legible");
});
