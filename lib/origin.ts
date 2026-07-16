/**
 * CSRF guard for state-changing / capability-granting routes. The service
 * binds loopback (see package.json / the launchd plist), but a malicious page
 * open in the owner's browser can still issue a cross-origin POST to
 * localhost:4183 as a "simple" request (no preflight) and trigger a side
 * effect it can't read — e.g. drive act-mode /api/chat (arbitrary code as the
 * user) or clear the kill switch.
 *
 * Policy: native clients (the vidi Swift app via URLSession, curl) send no
 * Origin header → allowed; the web UI is same-origin → allowed; a cross-origin
 * browser request carries a foreign Origin the attacker cannot forge (Origin
 * and Host are browser-controlled, forbidden headers) → rejected. This closes
 * the drive-by vector without adding auth infrastructure or touching any
 * consumer.
 */
/**
 * The loopback Host allowlist (Phase 4a — H5, closes DNS-rebinding F7). The
 * service binds IPv4 loopback and is reached only as one of these hosts. A
 * DNS-rebinding page defeats the Origin==Host equality (it controls BOTH
 * headers, so it can send matching evil.com pairs), but it cannot forge the
 * Host into the loopback allowlist while its Origin still says evil.com — and
 * even if it sets Host to a loopback value, the browser sends the attacker's
 * real Origin, which the equality check then rejects. So: Host must be in this
 * set for ANY request, native or browser.
 */
import { verifySessionToken } from "./session-token.ts";
import { verifyControlToken } from "./control.ts";
import { verifyPhoneToken } from "./phone-token.ts";

const DEFAULT_PORT = "4183";

function allowedHosts(): Set<string> {
  // The configured port (launchd/dev may override) plus the two loopback names.
  const port = (process.env.PORT || process.env.VIDI_PORT || DEFAULT_PORT).trim() || DEFAULT_PORT;
  const hosts = new Set<string>();
  for (const name of ["127.0.0.1", "localhost"]) {
    hosts.add(`${name}:${port}`);
    // The default port is always allowed even if PORT is set to something else,
    // so the frozen 4183 contract (VidiConfig.vidiChatBaseURL, tests) still holds.
    hosts.add(`${name}:${DEFAULT_PORT}`);
  }

  // Opt-in escape hatch (DEFAULT OFF — empty unless the deployer sets it). Each
  // comma-separated `host:port` here is treated EXACTLY like a loopback host:
  // isLoopbackHost() returns true for it, so app/layout.tsx ships the session
  // token to a page served under that Host and sameOriginOk() passes. That is
  // the whole Tier-2 tailnet gate, opened for the named hosts.
  //
  // SECURITY (read before setting): this reopens the raw-TCP forged-Host
  // posture Tier-2 deliberately closed. It exists only so the OWNER can reach
  // the UI over the tailnet by raw IP / MagicDNS name (e.g. a `tailscale serve
  // --tcp 4183` forward to a phone) without the pairing dance. ONLY set it to
  // this machine's own tailnet names, and ONLY while every device on the
  // tailnet is the owner's. It MUST be emptied before an untrusted device — or
  // a second user — joins the tailnet, at which point the pairing path
  // (lib/phone-browser-pairing.ts) is the correct surface. Set via the launchd
  // plist's EnvironmentVariables, never hard-coded.
  const trustedHosts = (process.env.VIDI_TRUSTED_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const trustedHost of trustedHosts) hosts.add(trustedHost);

  return hosts;
}

/**
 * Is this Host header one of the loopback hosts we actually serve? Exported so
 * a page-render gate (app/layout.tsx) can reuse the exact same allowlist
 * sameOriginOk uses for API routes — see requireReadAuth's page-level
 * counterpart, the SessionTokenShim Host check (Tier-2 fix-round finding 1).
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  return !!host && allowedHosts().has(host);
}

export function sameOriginOk(req: Request): boolean {
  const host = req.headers.get("host");
  // H5: the Host must be a loopback host we actually serve — this holds for the
  // native app (no Origin) and the web UI alike, and is what stops a
  // DNS-rebinding page (foreign Host, or foreign Origin against a loopback Host).
  if (!isLoopbackHost(host)) return false;

  const origin = req.headers.get("origin");
  if (!origin) return true; // no browser origin to forge (native app / curl)
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Standard 403 for a rejected cross-origin request. */
export function crossOriginResponse(): Response {
  return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
}

/**
 * Tier-2 tailnet gate. sameOriginOk() is a CSRF guard, not authentication: once
 * `tailscale serve` proxies the tailnet to this loopback server it can no longer
 * tell a genuinely-local request from a tailnet one (the proxy talks to
 * 127.0.0.1; a raw-TCP tailnet client can forge a loopback Host with no Origin
 * and pass). authorizedByToken() requires a POSITIVE credential a remote peer
 * cannot obtain — the session token (local browser, injected server-side into
 * the page), the control token (ops/vidictl), or the phone token. Any one of
 * the three admits its own caller class; a route composes the set it needs.
 *
 * The token libs only touch data/ lazily (on first verify call), so importing
 * them here has no import-time fs side effect.
 */
export function authorizedByToken(
  req: Request,
  which: { session?: boolean; control?: boolean; phone?: boolean } = { session: true, control: true }
): boolean {
  if (which.session && verifySessionToken(req)) return true;
  if (which.control && verifyControlToken(req)) return true;
  if (which.phone && verifyPhoneToken(req)) return true;
  return false;
}

/**
 * Read-route gate for the browser + ops + phone read surface (journal, goals,
 * user-config GET, agents, quota, threads, …). Requires a positive
 * session/control/phone token — NOT sameOriginOk — so the forged-loopback-Host
 * raw-TCP door is closed for every caller except the same-machine Swift app,
 * which does not hit these routes. Phone is included here (2026-07-07, live
 * curl confirmed GET /api/threads 401ing the phone Shortcut) so the phone can
 * read the thread list with the same per-install credential it already uses
 * for /api/phone/ask. Scope, honestly: the phone token is ONE secret with no
 * per-thread scoping — it reads ALL threads and the entire read surface, same
 * breadth as the session/control tokens. It must NOT gain write capability,
 * so requireWriteAuth below does its own {session, control} check rather than
 * delegating to this function. Returns a 401 Response to short-circuit, or
 * null to proceed.
 */
export function requireReadAuth(req: Request): Response | null {
  if (authorizedByToken(req, { session: true, control: true, phone: true })) return null;
  return Response.json({ error: "invalid or missing session token" }, { status: 401 });
}

/**
 * Write-route gate for the state-changing / capability-granting POST surface
 * (P8 finding 3 — the P7 re-audit's durable RCE fix). /api/chat and /api/loop
 * drive a write-capable act-mode agent; /api/user-config POST and /api/history
 * POST persist state the agent later reads (config, brain-indexed threads).
 * These routes previously trusted sameOriginOk() alone — but once `tailscale
 * serve` proxies the tailnet, a raw-TCP peer forges a loopback Host with no
 * Origin and passes sameOriginOk(), re-opening the act-mode RCE / brain-poison
 * write. Requiring a POSITIVE session/control token (which a remote peer cannot
 * read off this machine's disk) closes that door for good — exactly as
 * requireReadAuth does for the read surface. Same token set, same 401 contract;
 * the distinct name marks intent at the (POST) call site. A native caller that
 * relied on sameOriginOk (the Swift vision poster → /api/history) must be
 * rebuilt to attach x-vidi-control-token — see PR body.
 *
 * NOTE (2026-07-07): write and read used to share one check via delegation
 * (`return requireReadAuth(req)`), which is why requireReadAuth's phone grant
 * above could NOT simply be added without also opening every write route to
 * the phone token. requireWriteAuth now runs its own {session, control} check
 * — no phone — so the phone Shortcut's per-install token stays read-only
 * (GET /api/threads, etc.) and still cannot drive act-mode, delete a thread,
 * or spool an event. session/control remain identical between the two gates
 * on purpose (no least-privilege split exists between "can read my threads"
 * and "can drive an act-mode agent" for those two credentials); phone is the
 * one asymmetry, and it is intentional.
 *
 * ADDENDUM (2026-07-10, owner-approved deliberate elevation — see
 * THREAT_MODEL.md "B7"): this function's accepted credential set is
 * UNCHANGED — the phone token still does not pass requireWriteAuth, directly,
 * here or anywhere else. But `POST /api/phone/browser-session`
 * (verifyPhoneToken-gated, outside this file) now lets the phone token mint
 * the SAME `vidi-phone-browser` cookie `GET /pair` mints. Once a browser
 * carries that cookie, `app/layout.tsx`'s SessionTokenShim injects the REAL
 * session token into every page load — and that session token DOES pass
 * requireWriteAuth. Net effect: a device holding a valid phone token can, via
 * one extra request, obtain a full read+write browser session over the
 * tailnet. This was the owner's explicit, informed choice for the iOS app's
 * embedded Workspace tab (2026-07-10): the phone token was already the single
 * secret standing between "someone has the paired phone" and "can read
 * everything"; this widens that same compromise to "can also write" — it does
 * not add a new physical attack surface (a device-level compromise already
 * yielded the token). It is intentionally NOT a change to requireWriteAuth
 * itself — the write gate's direct credential set stays {session, control}
 * only, by design, so this doc's "phone is read-only" claim above remains
 * true of THIS function; the elevation is a one-hop bootstrap living entirely
 * in the browser-session route and lib/phone-browser-pairing.ts.
 */
export function requireWriteAuth(req: Request): Response | null {
  if (authorizedByToken(req, { session: true, control: true })) return null;
  return Response.json({ error: "invalid or missing session token" }, { status: 401 });
}

/**
 * Every requireReadAuth()-gated route (and app/layout.tsx's SessionTokenShim)
 * additionally exports `revalidate = 0` and `fetchCache = "force-no-store"`
 * alongside `dynamic = "force-dynamic"` (2026-07-06 fix round). Root-cause
 * finding: on a clean rebuild + fresh `next start` of the merged Tier-2 code
 * (two independent isolated builds), every gated route correctly 401'd with no
 * prerender/cache headers — `dynamic = "force-dynamic"` was NOT a no-op. The
 * false-positive report traced to a *long-running* `next start` process whose
 * `.next`/`NEXT_DIST_DIR` output directory got deleted-and-rebuilt out from
 * under it without a process restart — a live server holding stale manifest
 * file descriptors against a swapped-out build directory, not a caching-model
 * defect. These extra exports are additive defense-in-depth (belt-and-
 * suspenders against any future Next default-caching change) and cost nothing;
 * they do not change observed behavior on this codebase. See PR body for the
 * full before/after curl evidence.
 */

/**
 * Content-Type enforcement (Phase 4a — H6). A state-changing route that reads a
 * JSON body must require `Content-Type: application/json` (or no body at all).
 *
 * Why: a cross-origin browser form/fetch can send text/plain, multipart, or
 * urlencoded as a "simple" request WITHOUT a CORS preflight — the same class the
 * origin guard closes, but by a different door. Requiring application/json means
 * a state-changing POST cannot be a no-preflight simple request, so the browser
 * is forced to preflight (which same-origin policy then blocks). Native clients
 * (Swift URLSession, curl, the ops jobs) already send application/json, so this
 * is transparent to them.
 *
 * Returns a 415 Response to short-circuit, or null when the request may proceed.
 * A request with NO body (empty Content-Length / no content-type, e.g. a bare
 * "engage" POST) is allowed — the route's own JSON parse handles the empty case.
 */
export function requireJsonContentType(req: Request): Response | null {
  const contentType = req.headers.get("content-type");
  // No Content-Type header → treat as a bodyless request; the route's own
  // try/catch around req.json() covers an unexpectedly-empty parse.
  if (!contentType) return null;
  // A zero-length body carrying a stray content-type is still bodyless.
  const contentLength = req.headers.get("content-length");
  if (contentLength === "0") return null;
  // Accept application/json with any parameters (charset), case-insensitively.
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType === "application/json") return null;
  return Response.json(
    { error: "unsupported media type — send application/json" },
    { status: 415 }
  );
}
