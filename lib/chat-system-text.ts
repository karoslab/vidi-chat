import { personaToneBlock, readProfile } from "./onboarding.ts";
import { getAssistantName } from "./user-config.ts";
import { ASSISTANT_NAME } from "./assistant-identity.ts";

/**
 * A one-line persona-name override for a customized install (product ruling
 * 2026-07-11: the BRAND stays Vidi, but the persona NAME is per-install — the
 * first external customer names his "Anna"). VIDI_PERSONA.md still opens with
 * "You are Vidi"; this appended line renames the persona's SELF-reference
 * without rewriting the persona file. Returns null when the name is still the
 * default brand name, so a default install's prompt is byte-identical to before.
 */
export function assistantPersonaNameBlock(): string | null {
  let name: string;
  try {
    name = getAssistantName();
  } catch {
    return null;
  }
  if (!name || name === ASSISTANT_NAME) return null;
  return (
    `On this install your name is ${name}, not Vidi. ` +
    `Refer to yourself as ${name}. Everything else about who you are is unchanged.`
  );
}

/**
 * Extra system text for a TEXT-chat turn (POST /api/chat).
 *
 * The onboarding flow lets a new user pick a personality (warm / direct /
 * playful) which is stored as a tone preference. The VOICE path already injects
 * that tone (lib/voice-turn.ts appends personaToneBlock), but the text-chat
 * route did not — so the choice was silently ignored for the very surface a new
 * user builds on. This mirrors voice-turn's injection so the personality applies
 * to BOTH paths, and thus to BOTH plan and act spawns (claude.ts's
 * buildSystemPrompt appends extraSystemText regardless of mode).
 *
 * Pure-ish (reads the on-disk profile) and fail-open: any read error drops the
 * tone rather than breaking a turn. Returns undefined when there is no profile
 * (an existing install like the owner's) so the system prompt stays byte-identical
 * to today's default — the same absence guarantee personaToneBlock makes.
 */
export function chatExtraSystemText(): string | undefined {
  const parts: string[] = [];
  // Persona name first so it frames the tone that follows.
  const nameBlock = assistantPersonaNameBlock();
  if (nameBlock) parts.push(nameBlock);
  try {
    const tone = personaToneBlock(readProfile());
    if (tone) parts.push(tone);
  } catch {
    /* a read error just drops the tone block, never breaks a turn */
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
