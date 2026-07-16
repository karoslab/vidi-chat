import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The POST handler itself can't be imported under plain `node --test` — it
 * dynamically pulls the provider stack ("@/lib/voice-turn") that node's bare
 * resolver won't map. But the route's top level is deliberately alias-free, so
 * its PURE helper — buildPhoneAudioAction — imports cleanly and is what we test
 * here: the ?audio=1 action an iOS Shortcut "Get Contents of URL" runs.
 */
const { buildPhoneAudioAction } = await import("../app/api/phone/ask/route.ts");

test("audio action points at the ?speak=1 leg (not the worker) with the reply text", () => {
  const action = buildPhoneAudioAction(
    "http://mac.local:4183/api/phone/ask?audio=1",
    "tok123",
    "It's 3pm.",
  );

  // Points back at THIS route's speak leg — the proxy secret stays server-side.
  assert.equal(action.url, "http://mac.local:4183/api/phone/ask?speak=1");
  const q = new URL(action.url).searchParams;
  assert.equal(q.get("speak"), "1");
  assert.equal(q.get("audio"), null); // the audio flag is dropped

  assert.equal(action.method, "POST");
  assert.equal(action.headers["content-type"], "application/json");
  assert.equal(action.headers["x-vidi-phone-token"], "tok123");
  assert.deepEqual(JSON.parse(action.body), { text: "It's 3pm." });
});

test("audio action is a self-contained, JSON-serializable Shortcut input", () => {
  const action = buildPhoneAudioAction(
    "https://vidi.example/api/phone/ask?audio=1&x=y",
    "abc",
    "Hello.",
  );
  // The whole object must round-trip through JSON (it ships inside the reply).
  const round = JSON.parse(JSON.stringify(action));
  assert.deepEqual(round, action);
  // Every field the Get-Contents-of-URL action needs is present.
  for (const k of ["url", "method", "headers", "body"]) {
    assert.ok(k in action, `missing ${k}`);
  }
  // Extra query params on the incoming URL are cleared, leaving only speak=1.
  assert.equal(action.url, "https://vidi.example/api/phone/ask?speak=1");
});

test("forwarded host+proto rebuild the phone-visible origin (tailscale serve)", () => {
  const action = buildPhoneAudioAction(
    "https://localhost:4183/api/phone/ask?audio=1",
    "tok123",
    "Hello.",
    { host: "example-host.tailabcdef.ts.net", proto: "https" },
  );
  assert.equal(
    action.url,
    "https://example-host.tailabcdef.ts.net/api/phone/ask?speak=1",
  );
});

test("absent forwarded headers leave the request origin untouched", () => {
  const action = buildPhoneAudioAction(
    "http://127.0.0.1:4183/api/phone/ask?audio=1",
    "tok123",
    "Hello.",
    { host: null, proto: null },
  );
  assert.equal(action.url, "http://127.0.0.1:4183/api/phone/ask?speak=1");
});

test("forwarded host without proto keeps the request scheme", () => {
  const action = buildPhoneAudioAction(
    "https://localhost:4183/api/phone/ask?audio=1",
    "tok123",
    "Hello.",
    { host: "mac.tailnet.ts.net" },
  );
  assert.equal(action.url, "https://mac.tailnet.ts.net/api/phone/ask?speak=1");
});
