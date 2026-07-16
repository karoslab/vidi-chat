// Relative (not "@/") on purpose, same reason as app/api/phone/ask/route.ts:
// this route's top level must stay alias-free so IT — not just the lib
// functions it calls — imports cleanly and is directly callable under plain
// `node --test` (see tests/phone-browser-session.test.ts).
import { verifyPhoneToken } from "../../../../lib/phone-token.ts";
import { buildPhoneBrowserCookieHeader } from "../../../../lib/phone-browser-pairing.ts";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Phone-token-gated full browser-session bootstrap (2026-07-10, owner-
 * approved deliberate elevation of the phone token's scope — see
 * THREAT_MODEL.md "B7" and lib/origin.ts's requireWriteAuth doc comment for
 * the full rationale).
 *
 * The iOS app's embedded Workspace WKWebView already holds the per-install
 * phone token (read-only per requireReadAuth — it does NOT pass
 * requireWriteAuth). The CANONICAL full read+write browser session needs the
 * `vidi-phone-browser` HttpOnly cookie, which until now only `GET /pair`
 * (consuming a control-token-minted one-time code) could mint. This route
 * lets the app's ALREADY-HELD phone token mint that SAME cookie directly, in
 * one request, with no phone-browser-code round trip through the Mac.
 *
 * Reuses `buildPhoneBrowserCookieHeader()` — the EXACT cookie `/pair` mints,
 * identical name/value/attributes, single source of truth in
 * lib/phone-browser-pairing.ts so the two mints can never drift into
 * different shapes. No new cookie or session shape is introduced.
 *
 * POST only, deliberately no GET: a GET would be a CSRF-able side-effecting
 * link (a plain `<img src>`/navigation could trigger it with no preflight).
 * This route's only input is a header a cross-origin navigation cannot
 * attach, but POST-only removes the question entirely rather than relying on
 * that. No request body is read; nothing is echoed back in the response;
 * the phone token itself is never logged.
 */
export async function POST(req: Request): Promise<Response> {
  if (!verifyPhoneToken(req)) {
    return Response.json({ error: "invalid or missing phone token" }, { status: 401 });
  }
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": buildPhoneBrowserCookieHeader() },
  });
}
