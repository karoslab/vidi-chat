import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * The TTS route (app/api/tts/route.ts) uses "@/" alias imports that plain
 * `node --test` won't resolve, so — following the push-route convention — we
 * pin its two load-bearing contracts: the pure premium gate is exercised
 * directly in voice-tier.test.ts, and here we assert the ROUTE SOURCE actually
 * wires that gate (the exact class of "route forgot to call the gate" bug the
 * write-route-wiring test guards for auth). If the route stops gating premium
 * egress, or brings back the old blanket non-owner block, this fails by name.
 */

const ROUTE = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "app",
  "api",
  "tts",
  "route.ts"
);
const src = fs.readFileSync(ROUTE, "utf8");

test("TTS route gates premium egress through evaluatePremiumTts", () => {
  assert.match(src, /evaluatePremiumTts\s*\(/);
  assert.match(src, /readVoiceKey\s*\(/);
  assert.match(src, /hasVoiceEgressConsent\s*\(/);
});

test("TTS route returns the X-Vidi-Local-Only signal when not allowed", () => {
  assert.match(src, /X-Vidi-Local-Only/);
  assert.match(src, /localOnly:\s*true/);
});

test("TTS route no longer blanket-blocks every non-owner install", () => {
  // The old short-circuit `if (!isOwner()) return 503` blocked ALL non-owners;
  // premium is now key+consent gated instead. Assert that exact pattern is gone.
  assert.doesNotMatch(src, /if\s*\(\s*!\s*isOwner\(\)\s*\)\s*\{[\s\S]*?503/);
});

test("TTS route selects the owner key vs the pasted voice code, and forwards a voiceId", () => {
  assert.match(src, /owner\s*\?\s*proxyKey\(\)\s*:\s*voiceKey/);
  assert.match(src, /premiumVoiceId/);
  assert.match(src, /voiceId/);
});
