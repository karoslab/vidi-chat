import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

/**
 * The synthesize route (app/api/prompter/synthesize/route.ts) uses "@/" alias
 * imports plain `node --test` won't resolve, so — following the
 * tts-route-wiring / push-route convention — this pins the route's two
 * load-bearing contracts across the import seam:
 *
 *   1. BEHAVIOR (real code): synthesizeBrief propagates a provider throw. Its
 *      internal try/catch only guards JSON coercion, so a failing tier run
 *      rejects the promise — which is exactly what must reach the route's catch.
 *      (Regression guard: the route previously left this call UNWRAPPED and a
 *      provider failure returned a blank 0-byte 500 in the dress rehearsal.)
 *   2. SOURCE: the route wraps the model turn in try/catch and returns a plain,
 *      non-empty message with status 500 and NO stack — mirroring the interview
 *      route (app/api/journey/memory/interview POST).
 */

// Isolate persistence so importing the lib never touches the real workspace.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-synth-route-cwd-")));
process.env.VIDI_PROJECTS_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "vidi-synth-route-proj-")
);

const P = await import("../lib/prompter.ts");

function readyState() {
  let s = P.initialState();
  for (const topic of P.PROMPTER_TOPICS) {
    s = P.recordAnswer(s, { topic, text: `answer for ${topic}` });
  }
  return s;
}

test("synthesizeBrief propagates a provider throw (reaches the route's catch)", async () => {
  const state = readyState();
  assert.equal(P.isReady(state), true);
  const throwingRun: import("../lib/prompter.ts").TierRun = async () => {
    throw new Error("provider down");
  };
  await assert.rejects(() => P.synthesizeBrief(state, throwingRun), /provider down/);
});

const ROUTE = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "app",
  "api",
  "prompter",
  "synthesize",
  "route.ts"
);
const src = fs.readFileSync(ROUTE, "utf8");

test("synthesize route wraps the model turn in try/catch", () => {
  assert.match(src, /try\s*\{[\s\S]*synthesizeBrief\s*\([\s\S]*?\}\s*catch/);
});

test("synthesize route returns a non-empty plain 500 message, no stack", () => {
  assert.match(src, /status:\s*500/);
  assert.match(src, /I could not build your brief just now\. Please try again\./);
  // No raw error surfaced to the customer: no stack, no error interpolation.
  assert.doesNotMatch(src, /\.stack/);
  assert.doesNotMatch(src, /error:\s*`/);
});
