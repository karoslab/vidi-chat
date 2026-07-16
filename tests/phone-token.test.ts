import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The token resolves off process.cwd()+"/data", so isolate cwd into a fresh
// temp dir BEFORE importing (same pattern as control.test.ts).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-phone-token-test-")));
const { getPhoneToken, verifyPhoneToken } = await import("../lib/phone-token.ts");

test("phone token is 32 hex chars, stable, and file-persisted 0600", () => {
  const a = getPhoneToken();
  const b = getPhoneToken();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  const stat = fs.statSync(path.join(process.cwd(), "data", "phone-token"));
  assert.equal(stat.mode & 0o777, 0o600);
});

test("verifyPhoneToken accepts the right header, rejects others", () => {
  const tok = getPhoneToken();
  const mk = (h?: string) =>
    new Request("http://localhost/api/phone/ask", {
      headers: h ? { "x-vidi-phone-token": h } : {},
    });
  assert.equal(verifyPhoneToken(mk(tok)), true);
  assert.equal(verifyPhoneToken(mk("wrong")), false);
  assert.equal(verifyPhoneToken(mk()), false);
});
