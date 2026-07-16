import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate cwd so the action journal (data/journal.jsonl) writes to a throwaway
// dir, never the repo.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-push-test-")));

// This suite exercises the OWNER push path (the ntfy→Discord transport chain).
// pushToPhone now short-circuits to a no-op for a non-owner install (H8), and a
// fresh temp cwd would otherwise resolve non-owner — so mark this install owner.
fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), "data", "onboarded.json"),
  JSON.stringify({ onboarded: true, source: "existing-install" })
);

// Point the Discord transport at a script that does not exist BEFORE anything
// pushes, so no test ever actually posts to Discord. The spawn's async 'error'
// event is what we're exercising: a broken transport must degrade, not throw.
const {
  pushToPhone,
  setNotifyScriptPath,
  setNtfyTopicPath,
  recentDeliveries,
  resetDeliveries,
} = await import("../lib/push.ts");
setNotifyScriptPath("/no/such/notify-script-does-not-exist.py");

// Give ntfy a throwaway topic file per this suite so autogeneration is isolated.
const topicFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ntfy-")),
  "ntfy-topic"
);
setNtfyTopicPath(topicFile);

const realFetch = globalThis.fetch;

/** Install a fetch mock that records calls and returns a canned response. */
function mockFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetDeliveries();
});

test("pushToPhone resolves to a boolean and never throws (bogus script path)", async () => {
  mockFetch(() => new Response("", { status: 500 }));
  const result = await pushToPhone("Title", "Body", "high");
  assert.equal(typeof result, "boolean");
});

test("pushToPhone works with the default priority argument", async () => {
  mockFetch(() => new Response("", { status: 200 }));
  const result = await pushToPhone("Title", "Body");
  assert.equal(typeof result, "boolean");
});

test("ntfy is at the head of the chain: a successful ntfy POST short-circuits Discord", async () => {
  const calls = mockFetch((url, init) => {
    assert.match(url, /^https:\/\/ntfy\.sh\//);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Title, "Hello");
    return new Response("", { status: 200 });
  });
  const result = await pushToPhone("Hello", "World", "default");
  assert.equal(result, true);
  assert.equal(calls.length, 1, "ntfy was tried");
  // Non-critical: first success wins, so only ntfy ran — Discord never reached.
  const recs = recentDeliveries();
  assert.deepEqual(
    recs.map((r) => r.transport),
    ["ntfy"]
  );
  assert.equal(recs[0].ok, true);
});

test("Priority header maps critical→urgent, high→high, else default", async () => {
  const seen: string[] = [];
  mockFetch((_url, init) => {
    seen.push(init.headers.Priority);
    return new Response("", { status: 200 });
  });
  await pushToPhone("t", "b", "urgent");
  await pushToPhone("t", "b", "high");
  await pushToPhone("t", "b", "default");
  await pushToPhone("t", "b", "low");
  assert.deepEqual(seen, ["urgent", "high", "default", "default"]);
});

test("ntfy failure falls through to Discord (non-2xx and network error)", async () => {
  // Non-2xx: ntfy reports false, so the chain moves on and Discord is attempted
  // instead of the push being dropped. (Discord's launch outcome is
  // environment-dependent, so we assert the fall-through, not the final bool.)
  mockFetch(() => new Response("nope", { status: 503 }));
  await pushToPhone("T", "B", "high");
  let recs = recentDeliveries();
  assert.deepEqual(
    recs.map((r) => r.transport),
    ["ntfy", "discord"],
    "ntfy failed then Discord was attempted"
  );
  assert.equal(recs[0].ok, false, "ntfy hop reported failure");

  resetDeliveries();

  // Network error: fetch rejects → same fall-through, still no throw.
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await pushToPhone("T", "B", "high");
  assert.equal(typeof result, "boolean");
  recs = recentDeliveries();
  assert.deepEqual(
    recs.map((r) => r.transport),
    ["ntfy", "discord"]
  );
  assert.equal(recs[0].ok, false, "ntfy hop failed on network error");
});

test("critical (urgent) fans out to BOTH ntfy and Discord even when ntfy succeeds", async () => {
  const calls = mockFetch(() => new Response("", { status: 200 }));
  const result = await pushToPhone("Fire", "Now", "urgent");
  // Overall success (ntfy delivered), but Discord was still attempted.
  assert.equal(result, true);
  assert.equal(calls.length, 1, "ntfy sent");
  const recs = recentDeliveries();
  assert.deepEqual(
    recs.map((r) => r.transport),
    ["ntfy", "discord"],
    "both transports fired for a critical push"
  );
  assert.equal(recs[0].ok, true, "ntfy delivered");
});

test("ntfy topic is auto-generated on first use: 32 hex chars, mode 0600", async () => {
  const freshTopic = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vidi-ntfy-autogen-")),
    "ntfy-topic"
  );
  setNtfyTopicPath(freshTopic);
  assert.equal(fs.existsSync(freshTopic), false);

  let postedUrl = "";
  mockFetch((url) => {
    postedUrl = url;
    return new Response("", { status: 200 });
  });
  await pushToPhone("t", "b", "default");

  assert.equal(fs.existsSync(freshTopic), true, "topic file was created");
  const topic = fs.readFileSync(freshTopic, "utf8").trim();
  assert.match(topic, /^[0-9a-f]{32}$/, "16 random bytes as hex");
  assert.equal(postedUrl, `https://ntfy.sh/${topic}`, "POSTs to the minted topic");
  const mode = fs.statSync(freshTopic).mode & 0o777;
  assert.equal(mode, 0o600, "topic file is 0600");

  // Second use reads the same topic back — no regeneration.
  await pushToPhone("t", "b", "default");
  assert.equal(fs.readFileSync(freshTopic, "utf8").trim(), topic);

  setNtfyTopicPath(topicFile);
});
