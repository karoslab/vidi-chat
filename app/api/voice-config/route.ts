import {
  hasVoiceEgressConsent,
  hasVoiceKey,
  readVoiceConfig,
  setVoiceEgressConsent,
  storeVoiceKey,
  VoiceConfigValidationError,
  writeVoiceConfig,
  PREMIUM_VOICE_CATALOG,
  type VoiceConfig,
} from "@/lib/voice-tier";
import { isOwner } from "@/lib/user-config";
import { requireJsonContentType, requireReadAuth, requireWriteAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Voice-tier settings backend (2026-07-11). Exposes and edits the per-install
 * voice state: tier (system / premium), the chosen system voice, the premium
 * voice id, voice-egress consent, and whether a voice code is stored. The stored
 * voice code itself is NEVER returned — only whether one exists.
 *
 * GET  → { config, owner, hasVoiceKey, hasConsent, catalog }
 * POST { tier?, systemVoice?, premiumVoiceId?, voiceKey?, consent? }
 *      → apply each provided field and return the fresh state. Same-origin +
 *        session/control guarded like every state-changing route.
 */

function state() {
  return {
    config: readVoiceConfig(),
    owner: isOwner(),
    hasVoiceKey: hasVoiceKey(),
    hasConsent: hasVoiceEgressConsent(),
    catalog: PREMIUM_VOICE_CATALOG,
  };
}

export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  return Response.json(state());
}

export async function POST(req: Request) {
  // Storing a voice code / flipping egress consent turns on an external egress
  // path, so require a positive session/control token, not sameOriginOk alone.
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // The voice code first (validated + stored 0600), then consent, then the
    // tier/voice selection. Each field is optional; only provided keys apply.
    if (typeof body.voiceKey === "string") storeVoiceKey(body.voiceKey);
    if (typeof body.consent === "boolean") setVoiceEgressConsent(body.consent);

    const configOverrides: Partial<VoiceConfig> = {};
    if (body.tier === "system" || body.tier === "premium") configOverrides.tier = body.tier;
    if (typeof body.systemVoice === "string") configOverrides.systemVoice = body.systemVoice;
    if (typeof body.premiumVoiceId === "string") configOverrides.premiumVoiceId = body.premiumVoiceId;
    if (Object.keys(configOverrides).length > 0) writeVoiceConfig(configOverrides);

    return Response.json(state());
  } catch (err) {
    // A validation failure carries a plain-language message safe to show
    // verbatim → 400. Anything else (an unwritable file) is a generic 500.
    if (err instanceof VoiceConfigValidationError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("[voice-config] write failed:", err);
    return Response.json(
      { error: "Couldn't save your voice settings just now. Try again in a moment." },
      { status: 500 }
    );
  }
}
