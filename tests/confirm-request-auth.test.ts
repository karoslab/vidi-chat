import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P1 (B1) — /api/confirm/request is control-token gated. Parking a risky action
 * used to accept any same-origin/no-Origin local POST, so a blind local process
 * could file a bogus action to later coax an approval. It now requires
 * x-vidi-control-token (bin/vidi-act attaches it); a tokenless POST is 401 and
 * NOTHING is parked.
 *
 * The route uses "@/" imports plain `node --test` can't resolve, so we drive the
 * REAL verifyControlToken + confirm lib through the route's exact POST guard
 * order (same-origin is separate; this asserts the added token gate + that a
 * successful park returns the per-command nonce).
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-confirm-req-auth-")));
const { getControlToken, verifyControlToken } = await import("../lib/control.ts");
const { fileConfirm, hasPending, cancelPending } = await import("../lib/confirm.ts");

const TOKEN = getControlToken();
const T0 = 1_000_000_000_000;

const ALLOWED_KINDS = new Set(["hands", "gws-email", "gws-calendar", "write-file"]);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:4183/api/confirm/request", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "write-file", description: "write a file", payload: {} }),
  });
}

/**
 * The route's POST, verbatim in behavior for the token branch: verifyControlToken
 * first, then kind validation, then fileConfirm (which returns the nonce).
 */
function handle(
  request: Request,
  body: { kind: string; description: string; payload?: unknown },
  now: number
): { status: number; nonce?: string } {
  if (!verifyControlToken(request)) return { status: 401 };
  if (!ALLOWED_KINDS.has(body.kind)) return { status: 400 };
  if (!body.description.trim()) return { status: 400 };
  const { nonce } = fileConfirm(
    { kind: body.kind, payload: body.payload ?? null, description: body.description },
    { now }
  );
  return { status: 200, nonce };
}

test("tokenless park → 401 and NOTHING is filed", () => {
  cancelPending(T0);
  const res = handle(req(), { kind: "write-file", description: "write a file", payload: {} }, T0);
  assert.equal(res.status, 401);
  assert.equal(hasPending(T0), false, "a blind local POST must not be able to park an action");
});

test("park WITH the control token → 200 and returns a per-command nonce", () => {
  cancelPending(T0);
  const res = handle(
    req({ "x-vidi-control-token": TOKEN }),
    { kind: "write-file", description: "write a file", payload: {} },
    T0
  );
  assert.equal(res.status, 200);
  assert.equal(typeof res.nonce, "string");
  assert.ok((res.nonce ?? "").length >= 16);
  assert.equal(hasPending(T0), true, "an authed park files the action");
  cancelPending(T0);
});
