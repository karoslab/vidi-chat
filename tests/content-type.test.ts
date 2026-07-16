import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Phase 4a — H6. State-changing routes require Content-Type: application/json
 * (or no body) before reading req.json(), returning 415 otherwise. This forces
 * a would-be cross-origin POST out of the no-preflight "simple request" class.
 *
 * The route handlers use "@/" alias imports plain node --test can't resolve, so
 * we exercise the shared helper the routes call — reproducing the exact guard
 * line every state-changing route now runs after the origin check.
 */

const { requireJsonContentType, sameOriginOk, crossOriginResponse } = await import(
  "../lib/origin.ts"
);

function post(headers: Record<string, string>): Request {
  return new Request("http://localhost:4183/api/chat", { method: "POST", headers });
}

// The exact two-line guard a state-changing route runs (origin, then media type).
function gate(req: Request): Response | null {
  if (!sameOriginOk(req)) return crossOriginResponse();
  const bad = requireJsonContentType(req);
  if (bad) return bad;
  return null;
}

test("application/json is accepted", () => {
  assert.equal(
    requireJsonContentType(
      post({ host: "localhost:4183", "content-type": "application/json" })
    ),
    null
  );
});

test("application/json with a charset param is accepted", () => {
  assert.equal(
    requireJsonContentType(
      post({ host: "localhost:4183", "content-type": "application/json; charset=utf-8" })
    ),
    null
  );
});

test("text/plain is rejected with 415", () => {
  const res = requireJsonContentType(
    post({ host: "localhost:4183", "content-type": "text/plain" })
  );
  assert.ok(res, "text/plain must be rejected");
  assert.equal(res!.status, 415);
});

test("form/multipart content types are rejected", () => {
  for (const ct of [
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
  ]) {
    const res = requireJsonContentType(post({ host: "localhost:4183", "content-type": ct }));
    assert.equal(res?.status, 415, `${ct} must be 415`);
  }
});

test("no Content-Type (bodyless request) is allowed", () => {
  assert.equal(requireJsonContentType(post({ host: "localhost:4183" })), null);
});

test("Content-Length: 0 with a stray content-type is allowed (bodyless)", () => {
  assert.equal(
    requireJsonContentType(
      post({ host: "localhost:4183", "content-type": "text/plain", "content-length": "0" })
    ),
    null
  );
});

test("full guard: same-origin JSON passes, same-origin text/plain 415s", () => {
  assert.equal(
    gate(post({ host: "localhost:4183", origin: "http://localhost:4183", "content-type": "application/json" })),
    null
  );
  const rejected = gate(
    post({ host: "localhost:4183", origin: "http://localhost:4183", "content-type": "text/plain" })
  );
  assert.equal(rejected?.status, 415);
});
