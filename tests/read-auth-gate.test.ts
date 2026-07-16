import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * W1-auth: GET /api/context/vision and GET /api/goals used to be open reads —
 * any local page could pull recent voice/vision turns or the goal ledger. Both
 * now apply the same same-origin gate as GET /api/history: `if
 * (!sameOriginOk(req)) return crossOriginResponse()` as their first line.
 *
 * The route handlers can't be imported here — they use "@/" alias imports that
 * plain `node --test` won't resolve (see push-route.test.ts). So we exercise the
 * two load-bearing pieces exactly as the routes call them: the gate itself
 * (sameOriginOk + crossOriginResponse), reproducing the routes' guard line, and
 * the data functions the routes wrap (listGoals, the store) to pin the response
 * shapes. If either contract changes, the routes break and this catches it.
 */

// data/ round-trips (goals.json, the thread store) need an isolated cwd, set
// BEFORE the libs compute their cwd-based paths.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-read-gate-test-")));

const { sameOriginOk, crossOriginResponse } = await import("../lib/origin.ts");
const { listGoals, addGoal } = await import("../lib/goals.ts");
const { createThread, saveThread, updateThread, getThread, listThreads } =
  await import("../lib/store.ts");

// Build a GET request the way a browser / native caller would hit these routes.
function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "GET", headers });
}

// The exact guard line both routes now run as their first statement.
function gate(req: Request): Response | null {
  return sameOriginOk(req) ? null : crossOriginResponse();
}

// ---------------------------------------------------------------------------
// The gate: absent Origin passes, same-origin passes, foreign Origin rejected.
// Applies identically to both GET /api/context/vision and GET /api/goals.
// ---------------------------------------------------------------------------

test("absent Origin (Vidi Mac app / launchd curl) passes the read gate", () => {
  // The Swift app's URLSession GET /api/context/vision and the goal-tick curl
  // GET /api/goals send no Origin header — they must still be allowed.
  assert.equal(
    gate(get("http://localhost:4183/api/context/vision", { host: "localhost:4183" })),
    null
  );
  assert.equal(
    gate(get("http://localhost:4183/api/goals", { host: "localhost:4183" })),
    null
  );
});

test("same-origin browser request passes the read gate", () => {
  assert.equal(
    gate(
      get("http://localhost:4183/api/goals", {
        host: "localhost:4183",
        origin: "http://localhost:4183",
      })
    ),
    null
  );
});

test("foreign Origin is rejected with a 403", async () => {
  for (const url of [
    "http://localhost:4183/api/context/vision",
    "http://localhost:4183/api/goals",
  ]) {
    const rejected = gate(
      get(url, { host: "localhost:4183", origin: "https://evil.example.com" })
    );
    assert.ok(rejected, "cross-origin read must be rejected");
    assert.equal(rejected!.status, 403);
    assert.deepEqual(await rejected!.json(), {
      error: "cross-origin request rejected",
    });
  }
});

// ---------------------------------------------------------------------------
// Response shapes are unchanged by the gate — the routes still wrap the same
// data on the allowed path.
// ---------------------------------------------------------------------------

test("GET /api/goals shape unchanged: { goals: [...] }", () => {
  addGoal({ title: "keep the lights on" });
  const body = { goals: listGoals() };
  assert.ok(Array.isArray(body.goals));
  assert.equal(body.goals[0].slug, "keep-the-lights-on");
});

test("GET /api/context/vision shape unchanged: { recent, modelDigest } strings", async () => {
  const voice = createThread("claude", "auto", "auto");
  voice.title = "voice";
  saveThread(voice);
  await updateThread(voice.id, (th) => {
    th.messages.push({ role: "user", text: "what's the deploy window", ts: Date.now() });
    th.messages.push({ role: "assistant", text: "9am", ts: Date.now() });
  });

  // Reproduce the route's read the same way it builds `recent`: tail messages of
  // the voice/vision threads. We only assert the shape/type contract here.
  const titles = ["voice", "vision"];
  const lines: string[] = [];
  for (const meta of listThreads()) {
    if (meta.provider !== "claude") continue;
    if (!titles.includes(meta.title)) continue;
    const thread = getThread(meta.id);
    if (!thread) continue;
    for (const m of thread.messages) lines.push(m.text);
  }
  const body = { recent: lines.join("\n"), modelDigest: "" };
  assert.equal(typeof body.recent, "string");
  assert.equal(typeof body.modelDigest, "string");
  assert.match(body.recent, /deploy window/);
});
