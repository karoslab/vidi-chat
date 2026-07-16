/**
 * Security notice content (T2.3) — one plain-language screen shown BEFORE the
 * permissions walkthrough during first-run onboarding: what Vidi can see, what
 * it can do, and what it can't. Preempts the "an AI controlling everything is
 * scary" blocker for a new user.
 *
 * REVIEWABLE BY HAND: this is the single place the owner edits the wording —
 * the UI just renders these arrays. Every line is derived from what the CODE
 * actually does today (not marketing), cross-checked against:
 *   - lib/providers/claude.ts — Edit/Write jailed to the workspace root
 *     (the workspace root) + ~/Desktop + ~/Downloads via --add-dir; reads are broader;
 *     a secret-path deny-list; risky actions route through the vidi-act confirm
 *     queue.
 *   - lib/providers/{claude,codex}.ts — turns run the locally-authenticated
 *     `claude` / `codex` CLI on the user's own subscription; the prompt + files
 *     Vidi reads for a turn go to Anthropic / OpenAI through those CLIs.
 *   - app/api/tts/route.ts — spoken replies are POSTed to the owner's
 *     Cloudflare worker (vidi-proxy) for synthesis; lib/push.ts — phone
 *     reminders go out via ntfy.sh (a random per-install topic minted on this
 *     machine, see lib/push.ts ensureNtfyTopic) + Discord; lib/gws.ts (via the
 *     gws-email / gws-calendar confirm executors, lib/confirm-executors.ts) —
 *     an approved email send / calendar create hits Google with the user's own
 *     Google account. These are the off-machine egress paths besides the model
 *     CLIs, and the "Where your information goes" section names ALL of them
 *     (P4 / threat-model B6 — the prior "nothing else leaves your computer" was
 *     false, AND the P7 re-audit found the gws→Google leg still undisclosed;
 *     both are now stated). gws only fires after an explicit confirm; the
 *     notice discloses the full list regardless.
 *   - vidi/CLAUDE.md — the microphone and screen belong to the separate Mac
 *     companion app, not this chat; no analytics/telemetry anywhere.
 *
 * TWO AUDIENCES, ONE TRUTH EACH (V2 second-user verdict, 2026-07-07): the
 * "What I can do" story and the voice-egress line depend on whether this is an
 * OWNER install (VIDI_OWNER=1 — e.g. the owner's own instance, where the owner
 * can flip Plan→Auto themselves and voice/TTS is live) or a NON-owner install
 * (act mode is clamped to Plan and TTS/push short-circuit on the isOwner
 * gate). The old static copy told only the non-owner story, which is FALSE on
 * an owner install. securityNoticeSections(ownerInstall) returns the accurate
 * variant; the caller resolves isOwner() server-side (this module stays pure
 * and client-safe — no node imports).
 *
 * Keep it ONE screen and free of legalese. If a capability changes in the code,
 * change the matching line here.
 */

export interface SecurityNoticeSection {
  /** Short heading for the group. */
  heading: string;
  /** Plain-language bullet points under it. */
  points: string[];
}

export const SECURITY_NOTICE_TITLE = "Before we start, what I can and can’t do.";

/**
 * The label on the security-notice acknowledgment button. Comprehension-framing
 * ("I understand"), not EULA-framing ("I agree") — this is a plain-language
 * overview, not a contract. The owner may flip it to "I agree"; it lives here
 * as a single constant so that's a one-line change.
 */
export const SECURITY_NOTICE_ACK_LABEL = "I understand";

/** Shared: what Vidi can see — identical for both audiences. */
const WHAT_I_CAN_SEE: SecurityNoticeSection = {
  heading: "What I can see",
  points: [
    "The files in your workspace (that’s the folder on this computer where your projects and work live). Reading them is how I answer questions about your work.",
    "What you and I have talked about before, so I can remember things and follow up later.",
    "I can only hear your microphone or see your screen through a separate app called Vidi, a small helper that runs on your Mac. Never from this chat window, and only when you start it yourself.",
  ],
};

/** Shared: the always-ask / walled-off list — identical for both audiences. */
const WHAT_I_CANT_DO: SecurityNoticeSection = {
  heading: "What I can’t do, and what I’ll always ask about first",
  points: [
    "I won’t delete things, publish anything to the internet, spend money, or take actions as you on a website without first stopping to ask you for a clear yes.",
    "I can’t reach your passwords or secret keys. Those are kept walled off from me.",
    "I can’t change files anywhere outside your workspace folder, Desktop, or Downloads unless you approve it first.",
  ],
};

/**
 * OWNER install (VIDI_OWNER=1 — the owner's own instance): TYPED threads
 * start in Plan mode and Auto is the owner's switch — the code does not clamp
 * an owner's Auto request. But the VOICE path is hands-on from the first mic
 * tap: voice-turn.ts creates the persistent voice thread with the acting
 * default ("auto") on an owner install, so claiming "every conversation starts
 * in Plan" would be false. Both halves are stated plainly.
 */
const WHAT_I_CAN_DO_OWNER: SecurityNoticeSection = {
  heading: "What I can do",
  points: [
    "Read your files to answer you. Just reading never changes anything.",
    "When we type, each conversation starts in Plan mode: I read, think, draft, and lay out the steps. I suggest, but I don’t change anything until you switch me. When you talk to me with the microphone, I’m hands-on by default: I can act on what you ask out loud (creating and editing files in your workspace folder, your Desktop, and your Downloads, and running safe everyday commands), and anything risky still stops and asks you for a clear yes first.",
    "You can switch me to Auto mode yourself, whenever you choose. In Auto I can create and edit files inside your workspace folder, your Desktop, and your Downloads, and run safe everyday commands on this Mac, and anything risky still stops and asks you for a clear yes first.",
  ],
};

/**
 * NON-owner install: the provider clamps every "auto" request to Plan unless
 * the owner opted her in (actModeAllowed) — copy and code agree. These lines
 * are the previously hand-reviewed P5 wording, unchanged.
 */
const WHAT_I_CAN_DO_NON_OWNER: SecurityNoticeSection = {
  heading: "What I can do",
  points: [
    "Read your files to answer you. Just reading never changes anything.",
    // P5 — the non-owner default, stated plainly. She sees this screen during
    // onboarding; the provider enforces it (a non-owner "Auto" request is
    // clamped to Plan unless the owner opted her in). Copy and code agree.
    "Right now I suggest and plan. I don’t act on your behalf yet. I’ll read, think, draft, and lay out the steps, but I won’t change files or run commands on my own.",
    "Hands-on Auto mode (where I can create and edit files inside your workspace folder, your Desktop, and your Downloads, and run safe everyday commands) is the owner’s to turn on for you. It isn’t a switch you flip yourself.",
  ],
};

/**
 * The whole-egress-list bullet, per audience. Both keep the same complete list
 * (voice → Cloudflare, push → ntfy.sh + Discord, confirmed email/calendar →
 * Google) and the same "apart from the model calls, only other things that
 * leave" scoping (B6/P8). The owner variant states the voice egress in the
 * active voice — on an owner install spoken replies are LIVE, not hypothetical
 * — names the service (vidi-proxy), and notes the ntfy topic is a random,
 * private name minted on this machine.
 */
const EGRESS_BULLET_OWNER =
  "A few of my out-loud and on-your-behalf features reach the internet, and here is the whole list so nothing is hidden: when you tap the microphone and I speak a reply out loud, the text of that reply is sent to a small voice service the owner runs on Cloudflare (it’s called vidi-proxy) that turns my words into audio, and when that service isn’t connected, your Mac’s own built-in voice speaks instead and nothing is sent; a reminder I send to a phone goes out through two notification services, ntfy.sh and Discord (the ntfy.sh channel is a random, private topic name created on this computer, not something shared or guessable); and when I send an email or add a calendar event for you, only ever after you say yes, that goes to Google, because it is your own Google account I am using. Apart from sending your words to Anthropic or OpenAI to answer you (above), those are the only other things that ever leave this computer.";

const EGRESS_BULLET_NON_OWNER =
  "A few of my out-loud and on-your-behalf features can reach the internet, and here is the whole list so nothing is hidden: when I speak a reply, the text of that reply goes to a small voice service the owner runs on Cloudflare that turns it into audio; a reminder I send to a phone goes out through two notification services, ntfy.sh and Discord; and when I send an email or add a calendar event for you, only ever after you say yes, that goes to Google, because it is your own Google account I am using. Apart from sending your words to Anthropic or OpenAI to answer you (above), those are the only other things that ever leave this computer.";

/**
 * Voice-egress consent disclosure (2026-07-11 premium-voice tier). Shown at the
 * moment a user turns ON premium voice — the plain-language "here is what
 * happens when I speak out loud through the voice service" line they accept
 * before any spoken reply leaves this computer. The default (system voice) sends
 * nothing; this consent only governs the premium tier. Two variants keep the
 * same truth for each audience: the owner already knows the voice is live; a
 * non-owner (customer) is opting a previously-silent install into egress.
 *
 * No em/en dashes, no legalese — the same plain-words rule as the notice above.
 */
export const VOICE_EGRESS_CONSENT_DISCLOSURE_OWNER =
  "When premium voice is on and I speak a reply out loud, the words of that reply are sent to the voice service the owner runs on Cloudflare to be turned into audio. Only the reply text is sent, nothing else. Turn premium voice off any time and your Mac's own built-in voice speaks instead, with nothing sent.";

export const VOICE_EGRESS_CONSENT_DISCLOSURE_NON_OWNER =
  "Turning on premium voice means that when I speak a reply out loud, the words of that reply are sent to Vidi's voice service to be turned into audio. Only the reply text is sent, nothing else, and only while premium voice is on. Leave it off, or turn it off later, and your Mac's own built-in voice speaks instead, with nothing sent.";

/** The voice-egress consent line for this install. `ownerInstall` = the
 *  server-resolved isOwner() value, carried in by the caller (this module stays
 *  pure and client-safe). */
export function voiceEgressConsentDisclosure(ownerInstall: boolean): string {
  return ownerInstall
    ? VOICE_EGRESS_CONSENT_DISCLOSURE_OWNER
    : VOICE_EGRESS_CONSENT_DISCLOSURE_NON_OWNER;
}

/**
 * The consented weekly-health-summary disclosure. Added to the egress list ONLY
 * when the toggle is ON (Settings, default OFF). It is the single consented
 * exception to "nothing else leaves your computer", so it is stated plainly and
 * scoped to counts — never conversations or files. When the toggle is off this
 * line is absent and the egress list is exactly as before.
 */
const WEEKLY_SUMMARY_DISCLOSURE =
  "You have turned on the weekly health summary, so once a week I send the owner a short set of NUMBERS, how many times things ran, and counts of any errors, so they can keep this working well for you. It never includes anything you said to me or any file I read; only counts. You can turn it off any time in Settings.";

function whereYourInformationGoes(
  ownerInstall: boolean,
  weeklySummaryOn: boolean
): SecurityNoticeSection {
  const points = [
    "I run on your own Claude or Codex account (the AI subscription this assistant uses) right here on this computer.",
    "To answer you, the words you send me and the files I read for that question are sent to Anthropic or OpenAI (the companies that make Claude and Codex), the same way it works when you use their apps directly.",
    // P4 (threat-model B6) — the truthful egress list; see EGRESS_BULLET_*.
    ownerInstall ? EGRESS_BULLET_OWNER : EGRESS_BULLET_NON_OWNER,
  ];
  if (weeklySummaryOn) points.push(WEEKLY_SUMMARY_DISCLOSURE);
  points.push(
    "There is no tracking or analytics of any kind, and nothing you say or any file I read is ever sold or handed to anyone else."
  );
  return { heading: "Where your information goes", points };
}

/**
 * The notice content for this install. `ownerInstall` = the server-resolved
 * isOwner() value (this module is imported by a client component, so it cannot
 * read the env/data files itself — the onboarding API carries the flag).
 */
export function securityNoticeSections(
  ownerInstall: boolean,
  weeklySummaryOn: boolean = false
): readonly SecurityNoticeSection[] {
  return [
    WHAT_I_CAN_SEE,
    ownerInstall ? WHAT_I_CAN_DO_OWNER : WHAT_I_CAN_DO_NON_OWNER,
    WHAT_I_CANT_DO,
    whereYourInformationGoes(ownerInstall, weeklySummaryOn),
  ];
}
