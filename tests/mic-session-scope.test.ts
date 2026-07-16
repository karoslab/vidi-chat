import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * Mic session-scope wiring (2026-07-12 trust fix). The customer report was that
 * after using voice once, Safari's mic indicator stayed lit while the app was
 * open. Client components can't run under `node --test`, so — following the
 * settings-voice-wiring convention — we pin the load-bearing SOURCE contracts
 * that keep the mic session-scoped:
 *
 *   1. Chat drives capture through the session controller, not an inline
 *      recognizer whose only release was the browser's onend callback.
 *   2. Capture is single-utterance (continuous = false); there is no hands-free
 *      / always-listening mode anywhere in the tree.
 *   3. Backstops exist for when the browser never fires onend: pagehide, the
 *      tab going hidden, and the Pause pill panic.
 *   4. There is exactly ONE mic capture path in the app (the phone/iOS-web
 *      session embeds this same Chat), so the policy applies uniformly.
 */

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const chat = read("components/Chat.tsx");
const pause = read("components/PauseControl.tsx");
const registry = read("lib/mic-registry.ts");
const session = read("lib/voice-mic-session.ts");

test("Chat captures through the session controller, not an inline recognizer", () => {
  assert.match(chat, /createMicSession/);
  assert.match(chat, /micSessionRef/);
  // The old inline recognizer wired its onresult/onend/onerror by hand, with
  // release living only in the browser's onend callback. That is gone.
  assert.doesNotMatch(chat, /const releaseMic = \(\)/);
  assert.doesNotMatch(chat, /rec\.onend = \(\)/);
});

test("Chat toggles start/stop on the session and never leaves a hot recognizer", () => {
  assert.match(chat, /session\.start\(\)/);
  assert.match(chat, /session\.stop\(\)/);
  assert.match(chat, /session\.dispose\(\)/);
});

test("Chat has pagehide AND tab-hidden backstops that cancel capture", () => {
  assert.match(chat, /addEventListener\("pagehide"/);
  assert.match(chat, /visibilitychange/);
  assert.match(chat, /visibilityState === "hidden"/);
  assert.match(chat, /session\.cancel\(/);
});

test("capture is single-utterance — no hands-free / always-listening mode", () => {
  assert.match(session, /continuous = false/);
  // continuous is never set true anywhere (no hands-free path was added).
  assert.doesNotMatch(session, /continuous = true/);
  assert.doesNotMatch(chat, /continuous = true/);
});

test("the mic session releases the registry lease on every terminal path", () => {
  // teardown drops the lease, and it is called from stop/cancel/error/idle/panic.
  assert.match(session, /lease\.release\(\)/);
  assert.match(session, /function teardown\(\)/);
  assert.match(session, /onMicPanic/);
});

test("the Pause pill force-releases the mic instantly and locally", () => {
  assert.match(pause, /panicMicRelease/);
  // Before the network round-trip, not after.
  const engageIdx = pause.indexOf('action: "engage"');
  const panicIdx = pause.indexOf("panicMicRelease");
  assert.ok(panicIdx > -1 && engageIdx > -1 && panicIdx < engageIdx,
    "panicMicRelease must run before the /api/kill engage fetch");
});

test("panic is unconditional: force-drops leases even if a handler forgets", () => {
  assert.match(registry, /leases\.clear\(\)/);
  assert.match(registry, /function panicMicRelease/);
});

test("webkitSpeechRecognition is the ONLY mic capture path (phone reuses Chat)", () => {
  // No getUserMedia / MediaRecorder anywhere in the app source.
  const dirs = ["components", "lib", "app"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = read(rel);
        // Match actual API calls, not the doc-comment mentions in the registry.
        if (/\.getUserMedia\(|new MediaRecorder\(/.test(src)) offenders.push(rel);
      }
    }
  };
  for (const d of dirs) walk(d);
  assert.deepEqual(offenders, [], `unexpected raw mic capture in: ${offenders.join(", ")}`);
});
