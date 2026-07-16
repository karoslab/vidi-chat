import { readFileSync } from "node:fs";
import { workspacePath } from "./workspace.ts";
import { readVoiceKey } from "./voice-tier.ts";

/**
 * The install's vidi-proxy worker credential, resolved the SAME way the TTS
 * route resolves it (app/api/tts/route.ts): an OWNER install authenticates
 * with the on-disk `.proxy-secret` file; a CUSTOMER install authenticates with
 * the pasted per-install code stored by Voice settings (lib/voice-tier.ts
 * storeVoiceKey). The update channel must accept whichever this install has —
 * reading only `.proxy-secret` left every customer install unable to receive
 * updates (live repro 2026-07-12: key saved, updater still said "not set up").
 *
 * The key is sent to the worker as the `x-vidi-key` header and MUST stay
 * server-side — never shipped to the browser (the release/update routes run in
 * the Node runtime).
 */
const SECRET_FILE = workspacePath("vidi", ".proxy-secret");

/** The owner-install worker secret file, or null. */
export function readProxySecretFile(): string | null {
  try {
    const raw = readFileSync(SECRET_FILE, "utf8").trim();
    const m = raw.match(/^VIDI_PROXY_KEY=(.+)$/m);
    return (m ? m[1] : raw).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pure resolution rule: the owner secret file wins when present, else the
 * stored customer code. Mirrors tts/route.ts's owner-vs-customer asymmetry
 * without needing the owner flag — an install only ever has one of the two.
 * Exported separately so the rule is testable without filesystem state.
 */
export function resolveProxyKey(
  secretFileValue: string | null,
  voiceKeyValue: string | null
): string | null {
  return secretFileValue ?? voiceKeyValue;
}

/** The worker key this install actually has. */
export function readProxyKey(): string | null {
  return resolveProxyKey(readProxySecretFile(), readVoiceKey());
}
