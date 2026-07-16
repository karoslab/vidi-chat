import { test } from "node:test";
import assert from "node:assert/strict";

import { securityNoticeSections } from "../lib/security-notice.ts";

/**
 * Phase 4a — P4 (threat-model B6) + P5, extended by the V2 second-user track.
 * The security notice must tell the truth about egress AND about who can act.
 *
 * B6: the old copy claimed "nothing else leaves your computer," which was FALSE
 * — spoken replies are synthesized off-machine (Cloudflare) and phone reminders
 * push out (ntfy.sh + Discord). The rewrite states the whole list.
 *
 * V2: the notice is per-audience. The NON-owner variant keeps the P5 story
 * ("I suggest and plan; I don't act on your behalf yet," Auto is the owner's
 * to enable). The OWNER variant (VIDI_OWNER=1 — the owner's own instance) must
 * NOT tell that story — on the owner's install THEY flip Plan→Auto themselves
 * and voice is live — and must name the voice service and the random local
 * ntfy topic.
 */

const OWNER = securityNoticeSections(true);
const NON_OWNER = securityNoticeSections(false);

const flatten = (sections: readonly { heading: string; points: string[] }[]) =>
  sections
    .flatMap((s) => [s.heading, ...s.points])
    .join(" \n ")
    .toLowerCase();

const ownerText = flatten(OWNER);
const nonOwnerText = flatten(NON_OWNER);

/* ── shared egress truths (both audiences) ─────────────────────────────── */

for (const [label, allText, sections] of [
  ["owner", ownerText, OWNER],
  ["non-owner", nonOwnerText, NON_OWNER],
] as const) {
  test(`[${label}] B6: the false 'nothing else leaves your computer' claim is gone`, () => {
    assert.doesNotMatch(
      allText,
      /nothing else leaves your computer/,
      "the disproven absolute claim must not appear"
    );
  });

  test(`[${label}] B6: any 'only things that leave' claim is scoped to exclude the model calls`, () => {
    // The section already discloses (a bullet above) that words + files go to
    // Anthropic/OpenAI to answer you. So an UNQUALIFIED 'those are the only
    // things that ever leave this computer' is false — the same over-broad
    // absolute B6 flagged. If the notice makes an "only ... leave" claim it must
    // carve out the model API calls in the same breath.
    const claimsOnlyThingsLeave = /only (other )?things that (ever )?leave this computer/.test(
      allText
    );
    if (claimsOnlyThingsLeave) {
      assert.match(
        allText,
        /apart from|other than|besides|except/,
        "an 'only things that leave' claim must carve out the model calls it can't be absolute over"
      );
      assert.match(
        allText,
        /only other things that (ever )?leave this computer/,
        "the claim must be scoped ('only OTHER things'), not an unqualified absolute"
      );
    }
  });

  test(`[${label}] P4: the truthful egress list is stated — voice synthesis + push destinations`, () => {
    // Spoken replies are synthesized off-machine (the owner's Cloudflare worker).
    assert.match(allText, /cloudflare/);
    assert.match(allText, /voice|synthes|audio|spoke|speak/);
    // Phone reminders push out through ntfy.sh and Discord.
    assert.match(allText, /ntfy/);
    assert.match(allText, /discord/);
  });

  test(`[${label}] P4: still promises no analytics and that nothing is sold`, () => {
    assert.match(allText, /tracking|analytics/);
    assert.match(allText, /sold|handed to anyone|shared with/);
  });

  test(`[${label}] egress copy stays plain — no raw hostnames or internal identifiers`, () => {
    // ntfy.sh and Discord are product names users recognize; the worker may be
    // NAMED in plain language ("a small voice service ... called vidi-proxy")
    // but never as the raw internal hostname.
    assert.doesNotMatch(allText, /workers\.dev|vidi-proxy\./);
  });

  // P8 finding 4 (P7 re-audit) — the gws→Google egress leg was undisclosed. An
  // approved email send / calendar create (gws-email / gws-calendar confirm
  // executors → lib/gws.ts) leaves the machine for Google, but the old egress
  // bullet named only Cloudflare/ntfy/Discord, so the "only other things that
  // leave" claim was STILL false (a residual B6). The notice must disclose it.
  test(`[${label}] P8: the gws→Google egress (email/calendar on the user's account) is disclosed`, () => {
    assert.match(allText, /google/, "the Google egress destination must be named");
    assert.match(allText, /email|calendar/, "the email/calendar actions that egress must be named");
  });

  test(`[${label}] P8: the disclosed 'only other things that leave' list stays truthful with gws in it`, () => {
    // The B6-scoping test above already requires the 'apart from … model calls'
    // carve-out; here we pin that Google is inside the SAME whole-list bullet so
    // the absolute claim can't be read as excluding it.
    const egressBullet = sections
      .flatMap((s) => s.points)
      .find((p) => /only other things that (ever )?leave this computer/i.test(p));
    assert.ok(egressBullet, "the whole-egress-list bullet must exist");
    assert.match(egressBullet!.toLowerCase(), /google/, "Google must be in the same whole-list bullet");
  });
}

/* ── NON-owner story (P5 — unchanged, hand-reviewed wording) ───────────── */

test("non-owner P5: surfaces the Plan-first default — Vidi suggests, doesn't act yet", () => {
  assert.match(nonOwnerText, /suggest/);
  assert.match(nonOwnerText, /don.t act on your behalf|doesn.t act on your behalf/);
});

test("non-owner P5: Auto mode is the owner's to enable, not the user's own switch", () => {
  assert.match(nonOwnerText, /auto/);
  assert.match(nonOwnerText, /the owner/);
  // The opt-in belongs to the owner, not a self-serve toggle.
  assert.match(nonOwnerText, /turn on for you|to turn on|enable for you|isn.t a switch you flip/);
});

/* ── OWNER story (V2 — truth-first for an owner=1 install) ─────────────── */

test("owner: does NOT tell the non-owner story (the owner CAN act on their own install)", () => {
  // These lines are FALSE on an owner install and must not appear.
  assert.doesNotMatch(ownerText, /don.t act on your behalf|doesn.t act on your behalf/);
  assert.doesNotMatch(ownerText, /the owner.s to turn on for you/);
  assert.doesNotMatch(ownerText, /isn.t a switch you flip/);
});

test("owner: typed threads start in Plan (their switch); voice via the mic is hands-on by default", () => {
  // Typed half — Plan-first, suggest-only until the owner switches.
  assert.match(ownerText, /when we type/);
  assert.match(ownerText, /starts? in plan mode/);
  assert.match(ownerText, /don.t change anything until you switch/);
  assert.match(ownerText, /you can switch|switch me to auto|flip me to auto/);
  // Voice half — voice-turn.ts gives an OWNER's voice thread the acting
  // default ("auto"), so the mic path is hands-on from the first tap. The old
  // "EVERY conversation starts in Plan" claim was false and must stay gone.
  assert.match(ownerText, /talk to me with the microphone|via the mic/);
  assert.match(ownerText, /hands-on by default/);
  assert.match(ownerText, /act on what you ask/);
  assert.doesNotMatch(ownerText, /every conversation starts in plan/);
  // Risky actions still confirm first, on both paths.
  assert.match(ownerText, /asks? you for a clear yes/);
});

test("owner: the voice egress is stated in the active voice and names the service", () => {
  // On an owner install voice is LIVE — tapping the mic / spoken replies send
  // the reply text through the Cloudflare voice service (vidi-proxy).
  assert.match(ownerText, /microphone|mic/);
  assert.match(ownerText, /cloudflare/);
  assert.match(ownerText, /vidi-proxy/);
});

test("owner: the ntfy push topic is disclosed as a random, local, private name", () => {
  // lib/push.ts ensureNtfyTopic: a 32-hex random topic minted on this machine,
  // 0600 — the notice states it plainly (random + created on this computer).
  assert.match(ownerText, /random/);
  assert.match(ownerText, /created on this computer|minted on this|on this computer/);
});
