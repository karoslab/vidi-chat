import { test } from "node:test";
import assert from "node:assert/strict";

const {
  voiceEgressConsentDisclosure,
  VOICE_EGRESS_CONSENT_DISCLOSURE_OWNER,
  VOICE_EGRESS_CONSENT_DISCLOSURE_NON_OWNER,
} = await import("../lib/security-notice.ts");

/**
 * The voice-egress consent disclosure is the plain-language line a user accepts
 * before any spoken reply leaves this computer (premium tier). It must state
 * what leaves (the reply text), where it goes (the voice service), and the out
 * (turn it off, nothing is sent) — for both audiences, with no em/en dashes.
 */

for (const [label, copy] of [
  ["owner", VOICE_EGRESS_CONSENT_DISCLOSURE_OWNER],
  ["non-owner", VOICE_EGRESS_CONSENT_DISCLOSURE_NON_OWNER],
] as const) {
  test(`${label} voice disclosure states what leaves, where, and the out`, () => {
    assert.match(copy, /reply/i);
    assert.match(copy, /voice service|Cloudflare/i);
    assert.match(copy, /audio/i);
    assert.match(copy, /nothing (is )?sent|nothing sent/i);
  });

  test(`${label} voice disclosure has no em/en dashes`, () => {
    assert.ok(!/[—–]/.test(copy), "disclosure copy must not contain em/en dashes");
  });
}

test("voiceEgressConsentDisclosure picks the variant by ownership", () => {
  assert.equal(voiceEgressConsentDisclosure(true), VOICE_EGRESS_CONSENT_DISCLOSURE_OWNER);
  assert.equal(voiceEgressConsentDisclosure(false), VOICE_EGRESS_CONSENT_DISCLOSURE_NON_OWNER);
});
