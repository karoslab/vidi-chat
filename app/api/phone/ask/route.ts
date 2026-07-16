import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
// Relative (not "@/") on purpose: this route's top level must stay alias-free so
// the pure audio helpers import cleanly under plain `node --test` (see below).
import { workspacePath } from "../../../../lib/workspace.ts";
import { WORKER_BASE } from "../../../../lib/worker-url.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phone endpoint (Workstream C5) — the iOS Shortcut's way into Vidi's voice
 * brain. Same pipeline as /api/voice-command (runVoiceTurn on the shared
 * "voice" thread), so Mac and phone are ONE conversation and one memory — but
 * plain JSON instead of SSE, which is all a Shortcut can consume.
 *
 * Auth: header x-vidi-phone-token (lib/phone-token; data/phone-token holds the
 * per-install value, materialized at boot). No Origin check — the caller is
 * Shortcuts (no browser), so the token IS the guard here.
 *
 * POST { "transcript": string, "mode"?, "model"?, "effort"? }
 *   → 200 { "text": "<spoken reply>" }
 *   → 401 on a bad/absent token, 400 on a bad body.
 *
 * POST ?audio=1  → 200 { "text", "audio": { url, method, headers, body } }
 *   The `audio` object is exactly the inputs an iOS Shortcut "Get Contents of
 *   URL" action takes — run it to fetch the spoken reply in the ara voice.
 *
 * POST ?speak=1  { "text": string } → 200 audio/mpeg (the leg the ?audio=1
 *   action points at; proxies to the vidi-proxy /tts worker with the x-vidi-key
 *   SECRET injected server-side, so the key never reaches the phone).
 *
 * Fail-open like the rest of the voice path: runVoiceTurn never throws (a
 * failure comes back AS speakable text), so the phone always gets something to
 * read aloud. The imports below are lazy (dynamic) on purpose: it keeps this
 * module's top level free of the "@/" alias and the provider stack, so the pure
 * audio-action helpers stay unit-testable under plain `node --test`.
 */

// The vidi-proxy /tts worker is POST-only and needs the x-vidi-key secret, so
// the phone can't call it directly — it calls THIS route's ?speak=1 leg, which
// injects the key server-side (see handleSpeak).
const PROXY_TTS_URL = `${WORKER_BASE}/tts`;
// Same secret file + format the browser /api/tts route reads. Duplicated (not
// shared) because that route is same-origin-gated and outside this file's
// scope; the key never leaves the server on either path.
const SECRET_FILE = workspacePath("vidi", ".proxy-secret");
// Voice replies are written for the ear (1-3 sentences); cap rather than stream
// minutes of TTS, matching /api/tts.
const MAX_TTS_CHARS = 1200;

/** Read the vidi-proxy key server-side; null if unreadable. */
export function proxyKey(): string | null {
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

/**
 * Build the `?audio=1` playback action. Because the worker /tts route is
 * POST-only and needs the x-vidi-key SECRET (which must never reach the phone),
 * we do NOT point the Shortcut at the worker — we point it back at THIS route's
 * ?speak=1 leg, which proxies to the worker server-side. The returned object is
 * exactly what an iOS Shortcut "Get Contents of URL" action consumes: url,
 * method, headers, body. The phone already holds its x-vidi-phone-token, so we
 * echo the verified one back for a copy-paste-free Shortcut.
 */
export function buildPhoneAudioAction(
  requestUrl: string,
  phoneToken: string,
  text: string,
  forwarded?: { host?: string | null; proto?: string | null }
): { url: string; method: string; headers: Record<string, string>; body: string } {
  const speakUrl = new URL(requestUrl);
  // Behind a reverse proxy (tailscale serve), req.url carries the BACKEND host
  // ("localhost:4183") which the phone cannot reach — the action must point at
  // the origin the phone actually called, carried in the standard forwarded
  // headers. Only the requester sees this URL (with its own already-verified
  // token echoed back), so honoring the client-controllable header does not
  // widen exposure.
  const forwardedHost = forwarded?.host?.trim();
  if (forwardedHost) {
    // Parse via URL so a forwarded host WITHOUT a port also clears the backend
    // port (the .host setter alone keeps a pre-existing port).
    const proto = forwarded?.proto?.trim() || speakUrl.protocol.replace(":", "");
    const forwardedOrigin = new URL(`${proto}://${forwardedHost}`);
    speakUrl.protocol = forwardedOrigin.protocol;
    speakUrl.hostname = forwardedOrigin.hostname;
    speakUrl.port = forwardedOrigin.port;
  }
  speakUrl.search = ""; // drop ?audio=1 (and anything else) …
  speakUrl.searchParams.set("speak", "1"); // … leaving just the speak leg.
  return {
    url: speakUrl.toString(),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vidi-phone-token": phoneToken,
    },
    body: JSON.stringify({ text }),
  };
}

/**
 * ?speak=1 leg: the Shortcut posts the reply text back here and gets audio/mpeg
 * (ara voice). The vidi-proxy key is read from disk and injected server-side, so
 * it never reaches the phone. Mirrors /api/tts's upstream handling.
 */
async function handleSpeak(req: NextRequest): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "text required" }, { status: 400 });

  // Phase 4a — H8: a NON-owner install makes ZERO external network calls, so the
  // TTS worker is never reached from the phone speak leg either. The Shortcut
  // treats a non-2xx speak leg as "no audio" and reads the text reply. Dynamic
  // import keeps this module's top level alias/provider-free for the pure
  // audio-helper tests.
  const { isOwner } = await import("../../../../lib/user-config.ts");
  if (!isOwner()) {
    return Response.json(
      { error: "tts disabled on this install", localOnly: true },
      { status: 503 }
    );
  }

  const key = proxyKey();
  if (!key) {
    return Response.json({ error: "vidi-proxy secret unavailable" }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(PROXY_TTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vidi-key": key },
      body: JSON.stringify({ text: text.slice(0, MAX_TTS_CHARS) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    return Response.json(
      { error: `tts upstream unreachable: ${err?.message || "fetch failed"}` },
      { status: 502 }
    );
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: `tts upstream error (${upstream.status})` },
      { status: 502 }
    );
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req: NextRequest) {
  // Token gate first — no work for an unauthenticated caller.
  const { verifyPhoneToken } = await import("@/lib/phone-token");
  if (!verifyPhoneToken(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // The audio leg carries only { text }, not a transcript — handle it before we
  // try to read a transcript off the body.
  if (req.nextUrl.searchParams.get("speak") === "1") {
    return handleSpeak(req);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return Response.json({ error: "transcript required" }, { status: 400 });
  }

  // No SSE, no streaming callbacks — the phone wants only the final line. Same
  // brain, same thread, same commit-marker stripping as the Mac route.
  //
  // B1: approving a parked action ("confirm") requires the control token + the
  // per-command nonce here too — a phone-token-authed request is NOT a control
  // approval unless it also carries them. In practice the phone can't (there's
  // no overlay), so a phone "confirm" won't fire a parked side effect; approval
  // stays at the Mac, which matches "approval requires physical presence."
  const { verifyControlToken } = await import("@/lib/control");
  const { runVoiceTurn } = await import("@/lib/voice-turn");
  const text = await runVoiceTurn(transcript, {
    mode: body.mode,
    model: body.model,
    effort: body.effort,
    controlAuthorized: verifyControlToken(req),
    approvalNonce: typeof body.nonce === "string" ? body.nonce : undefined,
  });

  // ?audio=1 → also hand back a ready-to-run Shortcut action that fetches the
  // spoken reply (ara voice). Text-only otherwise, unchanged from C5.
  if (req.nextUrl.searchParams.get("audio") === "1") {
    const token = req.headers.get("x-vidi-phone-token") || "";
    return Response.json({
      text,
      audio: buildPhoneAudioAction(req.url, token, text, {
        host: req.headers.get("x-forwarded-host"),
        proto: req.headers.get("x-forwarded-proto"),
      }),
    });
  }

  return Response.json({ text });
}
