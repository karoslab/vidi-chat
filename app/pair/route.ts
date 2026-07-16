import {
  consumePairingCode,
  buildPhoneBrowserCookieHeader,
} from "@/lib/phone-browser-pairing";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * One-time phone-browser pairing: GET /pair?code=<minted code>. Opened once on
 * the phone (over the tailscale-serve HTTPS proxy); a valid code sets the
 * long-lived HttpOnly pairing cookie and redirects to the UI, which
 * app/layout.tsx's SessionTokenShim now recognizes. The code is single-use and
 * short-TTL (lib/phone-browser-pairing.ts), so the link left in Safari history
 * is inert after the first open. No auth beyond the code itself: possession of
 * a live code IS the credential, exactly like the app's runtime pairing.
 *
 * The cookie itself is minted by buildPhoneBrowserCookieHeader() — the SAME
 * helper POST /api/phone/browser-session calls (2026-07-10) — so the two
 * mints can never drift into different cookie shapes.
 */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code");
  if (!consumePairingCode(code)) {
    return new Response(
      "pairing link invalid or expired. Mint a fresh one from the Mac and reopen it",
      { status: 401, headers: { "content-type": "text/plain" } }
    );
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": buildPhoneBrowserCookieHeader() },
  });
}
