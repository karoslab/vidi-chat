import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the data dir BEFORE importing voice-tier: readVoiceKey / storeVoiceKey
// / consent / config all round-trip through dataPath(), which the live-data
// guard rejects unless a temp dir is pinned. Empty dir → safe defaults.
process.env.VIDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-voice-tier-"));

const DATA_DIR = process.env.VIDI_DATA_DIR!;

const {
  evaluatePremiumTts,
  validateVoiceKey,
  validateVoiceId,
  storeVoiceKey,
  readVoiceKey,
  hasVoiceKey,
  hasVoiceEgressConsent,
  setVoiceEgressConsent,
  readVoiceConfig,
  writeVoiceConfig,
  pickBestSystemVoice,
  PREMIUM_VOICE_CATALOG,
  VoiceConfigValidationError,
} = await import("../lib/voice-tier.ts");

const { SECRET_PATHS } = await import("../lib/providers/claude.ts");
const { matchesSecretPath } = await import("../lib/write-file-jail.ts");

function resetData() {
  for (const f of ["voice-key", "voice-consent.json", "voice-config.json"]) {
    try {
      fs.rmSync(path.join(DATA_DIR, f));
    } catch {
      /* nothing to clear */
    }
  }
}

const GOOD_KEY = "vidi_live_" + "a".repeat(48);

/* -------------------------------------------------------------------------- */
/* Premium-TTS gate matrix                                                     */
/* -------------------------------------------------------------------------- */

test("gate: OWNER is always allowed (uses the shared proxy secret)", () => {
  const d = evaluatePremiumTts({ owner: true, hasVoiceKey: false, hasConsent: false });
  assert.equal(d.allowed, true);
  assert.equal(d.status, 200);
});

test("gate: non-owner with BOTH a voice code and consent is allowed", () => {
  const d = evaluatePremiumTts({ owner: false, hasVoiceKey: true, hasConsent: true });
  assert.equal(d.allowed, true);
  assert.equal(d.status, 200);
});

test("gate: non-owner missing the voice code → 403, asks for the code", () => {
  const d = evaluatePremiumTts({ owner: false, hasVoiceKey: false, hasConsent: true });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 403);
  assert.match(d.message!, /voice code/i);
  // Plain-language copy rule: no em/en dashes.
  assert.ok(!/[—–]/.test(d.message!), "message must not contain em/en dashes");
});

test("gate: non-owner with a code but no consent → 403, asks for consent", () => {
  const d = evaluatePremiumTts({ owner: false, hasVoiceKey: true, hasConsent: false });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 403);
  assert.match(d.message!, /okay|voice service/i);
  assert.ok(!/[—–]/.test(d.message!), "message must not contain em/en dashes");
});

test("gate: non-owner with NEITHER → 403 and names the code first", () => {
  const d = evaluatePremiumTts({ owner: false, hasVoiceKey: false, hasConsent: false });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 403);
  assert.match(d.message!, /voice code/i);
});

/* -------------------------------------------------------------------------- */
/* Voice-code validation + secret-protected storage                            */
/* -------------------------------------------------------------------------- */

test("validateVoiceKey accepts a real vidi_live_ key and rejects junk", () => {
  assert.equal(validateVoiceKey(GOOD_KEY), null);
  assert.match(validateVoiceKey("")!, /Paste the voice code/);
  assert.match(validateVoiceKey("sk-not-a-vidi-key")!, /vidi_live_/);
  assert.match(validateVoiceKey("vidi_live_xyz")!, /incomplete/);
  // No em/en dashes in any rejection message.
  for (const bad of ["", "sk-nope", "vidi_live_zz"]) {
    const msg = validateVoiceKey(bad);
    if (msg) assert.ok(!/[—–]/.test(msg));
  }
});

test("storeVoiceKey writes the code 0600 and readVoiceKey round-trips it", () => {
  resetData();
  assert.equal(hasVoiceKey(), false);
  storeVoiceKey(GOOD_KEY);
  assert.equal(readVoiceKey(), GOOD_KEY);
  assert.equal(hasVoiceKey(), true);
  const mode = fs.statSync(path.join(DATA_DIR, "voice-key")).mode & 0o777;
  assert.equal(mode, 0o600, `voice-key must be 0600, got ${mode.toString(8)}`);
});

test("storeVoiceKey rejects a bad paste and stores nothing", () => {
  resetData();
  assert.throws(() => storeVoiceKey("not-a-key"), VoiceConfigValidationError);
  assert.equal(hasVoiceKey(), false);
});

test("storeVoiceKey with empty string clears a previously stored code", () => {
  resetData();
  storeVoiceKey(GOOD_KEY);
  assert.equal(hasVoiceKey(), true);
  storeVoiceKey("   ");
  assert.equal(hasVoiceKey(), false);
});

test("the stored voice code is on the SECRET_PATHS denylist", () => {
  assert.ok(
    SECRET_PATHS.includes("**/data/voice-key"),
    "SECRET_PATHS must deny **/data/voice-key"
  );
  // The `**/data/voice-key` glob matches the real per-install path (cwd/data/…),
  // which is what the agent's Read/Edit/Write jail sees in production.
  assert.equal(matchesSecretPath("/Users/example/workspace/vidi-chat/data/voice-key"), true);
  // And it must NOT accidentally match some other data file.
  assert.equal(matchesSecretPath("/Users/example/workspace/vidi-chat/data/voice-config.json"), false);
});

/* -------------------------------------------------------------------------- */
/* Consent                                                                     */
/* -------------------------------------------------------------------------- */

test("consent defaults to false and round-trips through set/read", () => {
  resetData();
  assert.equal(hasVoiceEgressConsent(), false);
  setVoiceEgressConsent(true);
  assert.equal(hasVoiceEgressConsent(), true);
  setVoiceEgressConsent(false);
  assert.equal(hasVoiceEgressConsent(), false);
});

/* -------------------------------------------------------------------------- */
/* Voice config validation                                                     */
/* -------------------------------------------------------------------------- */

test("readVoiceConfig defaults to the system tier on a fresh install", () => {
  resetData();
  const cfg = readVoiceConfig();
  assert.equal(cfg.tier, "system");
  assert.equal(cfg.systemVoice, undefined);
  assert.equal(cfg.premiumVoiceId, undefined);
});

test("writeVoiceConfig persists a premium selection and a system voice", () => {
  resetData();
  const cfg = writeVoiceConfig({ tier: "premium", premiumVoiceId: "ara", systemVoice: "Samantha" });
  assert.equal(cfg.tier, "premium");
  assert.equal(cfg.premiumVoiceId, "ara");
  assert.equal(cfg.systemVoice, "Samantha");
  // Persisted, not just returned.
  assert.deepEqual(readVoiceConfig(), cfg);
});

test("writeVoiceConfig rejects an unknown tier and an unknown voice id", () => {
  resetData();
  assert.throws(() => writeVoiceConfig({ tier: "loud" as any }), VoiceConfigValidationError);
  assert.throws(() => writeVoiceConfig({ premiumVoiceId: "definitely not a voice" }), VoiceConfigValidationError);
});

test("validateVoiceId accepts catalog ids and ElevenLabs passthrough, rejects junk", () => {
  assert.equal(validateVoiceId("ara"), null);
  assert.equal(validateVoiceId("EXAVITQu4vr4xnSDxMaL"), null); // ElevenLabs-style id
  assert.match(validateVoiceId("nope nope")!, /don't|not a voice|recognize/i);
  assert.match(validateVoiceId("")!, /Pick a premium voice/);
});

test("premium catalog includes grok 'ara' as the default", () => {
  const ara = PREMIUM_VOICE_CATALOG.find((v) => v.id === "ara");
  assert.ok(ara);
  assert.equal(ara!.provider, "grok");
});

/* -------------------------------------------------------------------------- */
/* System-voice picker (pure)                                                  */
/* -------------------------------------------------------------------------- */

test("pickBestSystemVoice prefers the stored choice, then high-quality en-US", () => {
  const voices = [
    { name: "Daniel", lang: "en-GB" },
    { name: "Samantha", lang: "en-US" },
    { name: "Rishi", lang: "en-IN" },
  ];
  assert.equal(pickBestSystemVoice(voices, "Rishi"), "Rishi"); // stored choice wins
  assert.equal(pickBestSystemVoice(voices), "Samantha"); // else the good en-US voice
  assert.equal(pickBestSystemVoice([{ name: "Zira", lang: "en-US" }]), "Zira"); // else any en-US
  assert.equal(pickBestSystemVoice([{ name: "Kyoko", lang: "ja-JP" }]), "Kyoko"); // else first
  assert.equal(pickBestSystemVoice([]), null);
});
