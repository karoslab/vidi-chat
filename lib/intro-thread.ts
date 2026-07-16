import fs from "node:fs";
import { dataDir, dataPath } from "./data-dir.ts";
import { createThread, getThread, saveThread, type Thread } from "./store.ts";
import { personaToneBlock, readProfile, PERSONALITIES, type PersonalityId } from "./onboarding.ts";
import { getAssistantName } from "./user-config.ts";

/**
 * Onboarding intro chat (T2.2).
 *
 * After the 4-step onboarding flow completes (NOT in replay mode), the user
 * drops into a scripted-but-conversational first session on a dedicated thread
 * whose `type` is "intro" — persisted under dataDir() like any thread, but
 * EXCLUDED from the sidebar list / search (see store.listThreads). Vidi
 * introduces herself in the chosen personality tone and offers the five starter
 * prompts as tappable cards.
 *
 * DETERMINISTIC-FIRST: the intro's opening message is composed here with no
 * model call — rendering the intro must never depend on the CLI being up. The
 * model only engages when the user actually replies (that reply rides the
 * normal /api/chat pipeline on this same thread).
 *
 * RE-TRIGGERABLE: like onboarding replay, the intro can be reopened later. A
 * pointer file remembers the single intro thread id so re-entry reuses it
 * rather than spawning duplicates.
 */

const introPointerFile = () => dataPath("intro-thread.json");

/**
 * The tone-flavored opening line Vidi speaks first. Deterministic — built from
 * the stored personality (via personaToneBlock's source) with a plain fallback
 * when there's no profile yet. No model call.
 *
 * Vidi's identity is fixed: she introduces herself as Vidi and leads straight
 * into the starter prompts. She never asks to be renamed — "Vidi is who she is
 * going to be" (product ruling 2026-07-05).
 */
export function introOpeningMessage(personality: PersonalityId | null): string {
  // The persona self-name (e.g. a customer's "Anna"), never the hardcoded
  // brand; and no dashes in customer-visible copy (the no-dashes rule).
  const name = getAssistantName();
  const base =
    `Hi, I'm ${name}, your assistant. I'm an AI that lives on your computer: you ` +
    "can ask me things, I'll look through your files to answer, I'll remember " +
    "what matters to you, and I can help get real work done. Try one of the " +
    "prompts below, or just tell me what you're working on.";
  // Nudge the phrasing by tone, honestly small — same spirit as personaToneBlock.
  switch (personality) {
    case "direct":
      return `I'm ${name}, your assistant. I'm an AI on your computer: ask me things, I read your files to answer, I remember what matters, and I can get work done. Pick a prompt below, or just tell me what you need.`;
    case "playful":
      return `Hi hi, I'm ${name}, your new sidekick. I'm an AI that lives on your computer: ask me anything, I'll dig through your files to answer, I'll remember what matters, and I can actually get stuff done. Grab one of the prompts below, or just tell me what you're up to.`;
    case "warm":
      return `Hi there, I'm ${name}, and I'm so glad you're here. I'm an AI assistant that lives right on your computer: you can ask me anything, I'll read through your files to answer, I'll remember the things that matter to you, and I can help you get real work done. Try one of the prompts below, or just tell me what's on your mind.`;
    default:
      return base;
  }
}

function readPointer(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(introPointerFile(), "utf8"));
    if (parsed && typeof parsed.threadId === "string") return parsed.threadId;
  } catch {
    /* no pointer yet */
  }
  return null;
}

function writePointer(threadId: string): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(introPointerFile(), JSON.stringify({ threadId, at: new Date().toISOString() }, null, 2));
  } catch {
    /* best-effort — the intro still works, it just may re-create next time */
  }
}

/** The stored personality (from the onboarding profile), or null. */
function currentPersonality(): PersonalityId | null {
  const profile = readProfile();
  if (!profile) return null;
  return PERSONALITIES.some((p) => p.id === profile.personality) ? profile.personality : null;
}

/**
 * Find-or-create the single intro thread and return it, guaranteeing it opens
 * with Vidi's deterministic tone-flavored greeting as the first message. If the
 * pointer thread still exists it's reused (re-triggering the intro reopens the
 * same conversation); otherwise a fresh "intro"-typed thread is created and
 * seeded. The greeting is a normal assistant message so the existing chat UI
 * renders it with zero special-casing and a user reply continues it via
 * /api/chat.
 */
export function getOrCreateIntroThread(): Thread {
  const existingId = readPointer();
  if (existingId) {
    const existing = getThread(existingId);
    if (existing && existing.type === "intro") return existing;
  }

  // A plan-mode claude thread — the intro is a first conversation, not an
  // action session. personaToneBlock is consulted for the tone at turn time via
  // the normal voice/chat path; here we only seed the deterministic opener.
  const thread = createThread("claude", "auto", "plan");
  thread.type = "intro";
  thread.title = "Getting started with Vidi";
  const greeting = introOpeningMessage(currentPersonality());
  thread.messages.push({ role: "assistant", text: greeting, ts: Date.now() });
  saveThread(thread);
  writePointer(thread.id);
  return thread;
}

/** The intro thread id if one exists, else null (no side effects). */
export function introThreadId(): string | null {
  const id = readPointer();
  if (!id) return null;
  const t = getThread(id);
  return t && t.type === "intro" ? id : null;
}

/** Exposed for the tone block so callers/tests can assert the persona wiring is
 *  reused rather than reimplemented. */
export { personaToneBlock };
