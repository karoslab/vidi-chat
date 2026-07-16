import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { requireWriteAuth } from "@/lib/origin";
import { workspacePath } from "@/lib/workspace";
import { isOwner } from "@/lib/user-config";
import { WORKER_BASE } from "@/lib/worker-url";
import {
  evaluatePremiumTts,
  hasVoiceEgressConsent,
  readVoiceConfig,
  readVoiceKey,
} from "@/lib/voice-tier";
import { bumpDiagUsage, recordDiag } from "@/lib/diag-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { text } → audio/mpeg of the premium voice saying it, synthesized by the
 * vidi-proxy worker (Grok "ara" by default; other grok voices and ElevenLabs
 * voice ids via the per-install premiumVoiceId).
 *
 * Server-side proxy on purpose: the worker wants an x-vidi-key secret which must
 * never reach the browser, and keeping the fetch here means the page CSP stays
 * connect-src 'self'. The client falls back to speechSynthesis (the free system
 * tier) whenever this route is non-2xx — which is the DEFAULT for a fresh
 * install, so a non-owner who has not opted into premium just speaks locally.
 *
 * Three tiers (lib/voice-tier.ts):
 *   - OWNER                     → the shared proxy secret (unchanged, unmetered).
 *   - non-owner + code + consent → the pasted per-install voice code (metered).
 *   - anyone else               → a plain-language 4xx + X-Vidi-Local-Only, so
 *                                  the client speaks with the system voice.
 */

const PROXY_URL = `${WORKER_BASE}/tts`;
const SECRET_FILE = workspacePath("vidi", ".proxy-secret");
// Voice replies are written for the ear (1-3 sentences); anything huge is a
// mistake upstream — cap it rather than stream minutes of TTS.
const MAX_TTS_CHARS = 1200;

function proxyKey(): string | null {
  try {
    // File format: `VIDI_PROXY_KEY=<key>` (same file the menu-bar app reads);
    // tolerate a bare key too.
    const raw = readFileSync(SECRET_FILE, "utf8").trim();
    const m = raw.match(/^VIDI_PROXY_KEY=(.+)$/m);
    return (m ? m[1] : raw).trim() || null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  // P8 finding 3 follow-up (2nd re-review, non-blocking-but-done): this is an
  // undisclosed-to-attackers egress path — it burns the vidi-proxy secret +
  // Cloudflare quota on every call. requireWriteAuth over sameOriginOk closes
  // the forged-loopback-Host raw-TCP door here too. Sole caller is the browser
  // (components/Chat.tsx, plain fetch), already carrying the session token via
  // the layout fetch-shim — no native/Swift caller hits this route directly
  // (the phone's ?speak=1 leg calls the vidi-proxy worker directly, bypassing
  // this route entirely — see app/api/phone/ask/route.ts).
  const unauthorized = requireWriteAuth(req);
  if (unauthorized) return unauthorized;
  // Premium-TTS gate (2026-07-11): the OWNER always synthesizes (shared proxy
  // secret). A non-owner needs a pasted voice code AND explicit voice-egress
  // consent. Anyone not eligible gets a plain-language 4xx + X-Vidi-Local-Only
  // so the client speaks with the free system voice and NOTHING leaves this
  // computer — the DEFAULT for a fresh install.
  const owner = isOwner();
  const voiceKey = readVoiceKey();
  const decision = evaluatePremiumTts({
    owner,
    hasVoiceKey: !!voiceKey,
    hasConsent: hasVoiceEgressConsent(),
  });
  if (!decision.allowed) {
    // Not an error — this install speaks on-device. Count it as local TTS usage
    // for the weekly summary (a number, no content).
    bumpDiagUsage("tts.local");
    return Response.json(
      { error: decision.message, localOnly: true },
      { status: decision.status, headers: { "X-Vidi-Local-Only": "1" } }
    );
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "text required" }, { status: 400 });

  // Key selection: the owner uses the shared proxy secret; an eligible non-owner
  // uses the pasted per-install voice code (the decision above proved it exists).
  const key = owner ? proxyKey() : voiceKey;
  if (!key) {
    // Only reachable on an owner install whose .proxy-secret is missing — fall
    // the client back to the system voice rather than erroring visibly.
    recordDiag("tts-fail", "vidi-proxy secret unavailable"); // observe-only
    return Response.json(
      { error: "vidi-proxy secret unavailable", localOnly: true },
      { status: 503, headers: { "X-Vidi-Local-Only": "1" } }
    );
  }

  // Per-install voice selection: a grok voice id or an ElevenLabs voice id
  // passthrough. Sent as `voiceId`; a worker that ignores it returns its own
  // configured default voice, so this is forward-compatible with today's worker.
  const voiceId = readVoiceConfig().premiumVoiceId;
  const upstreamBody: Record<string, unknown> = { text: text.slice(0, MAX_TTS_CHARS) };
  if (voiceId) upstreamBody.voiceId = voiceId;

  let upstream: Response;
  try {
    upstream = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vidi-key": key },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    recordDiag("tts-fail", `tts upstream unreachable: ${err?.message || "fetch failed"}`);
    return Response.json(
      { error: `tts upstream unreachable: ${err?.message || "fetch failed"}` },
      { status: 502 }
    );
  }
  if (!upstream.ok || !upstream.body) {
    recordDiag("tts-fail", `tts upstream error (${upstream.status})`);
    return Response.json(
      { error: `tts upstream error (${upstream.status})` },
      { status: 502 }
    );
  }
  bumpDiagUsage("tts.premium"); // successful worker TTS (a count, no content)
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
