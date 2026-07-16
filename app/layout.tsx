import type { Metadata, Viewport } from "next";
import "./globals.css";
import { cookies, headers } from "next/headers";

import { getSessionToken } from "@/lib/session-token";
import { getUserConfig } from "@/lib/user-config";
import { isLoopbackHost } from "@/lib/origin";
import {
  PHONE_BROWSER_COOKIE_NAME,
  verifyPhoneBrowserCookieValue,
} from "@/lib/phone-browser-pairing";

export const metadata: Metadata = {
  title: "Vidi",
  description: `${getUserConfig().displayName}'s personal chat. Runs on their subscriptions, no API keys.`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Defense-in-depth (2026-07-06 fix round): SessionTokenShim already forces
// per-request dynamic rendering by reading `headers()` — verified on two
// independent clean builds (see lib/origin.ts's note above requireReadAuth).
// revalidate = 0 is additionally explicit so a static/ISR cache is never a
// question for this layout, whatever future default Next ships.
export const revalidate = 0;

/**
 * Tier-2: attach the machine-local session token to same-origin /api fetches so
 * the browser satisfies requireReadAuth() without touching every component's
 * fetch call. The token is read server-side (never shipped in JS source) and
 * inlined once here; the shim wraps fetch to add x-vidi-session-token only for
 * same-origin requests to /api/, leaving cross-origin and asset fetches alone.
 *
 * CRITICAL: page routes (this layout) are NOT covered by the /api Host
 * allowlist requireReadAuth enforces — only /api/* handlers check Host. So
 * inlining the token unconditionally would hand it to ANY page load, including
 * one reached via the tailscale-serve HTTPS proxy (Host: *.ts.net), which then
 * replays x-vidi-session-token against every token-gated route — self-defeating
 * the whole gate (fix-round finding 1, 2026-07-06). Fix: gate the injection on
 * the INCOMING request's own Host header, using the exact same loopback
 * allowlist requireReadAuth's callers rely on (isLoopbackHost, lib/origin.ts).
 * A ts.net (or any non-loopback) Host renders the page WITHOUT the token — the
 * UI degrades to unauthenticated reads (401s show as empty state) rather than
 * leaking a working credential to a tailnet browser.
 *
 * ONE exception to the Host gate (phone-browser pairing, lib/
 * phone-browser-pairing.ts): a non-loopback browser carrying the HttpOnly
 * pairing cookie — set only by GET /pair consuming a control-token-minted
 * one-time code — has proven it belongs to this install, so it receives the
 * shim too. That is what makes the phone work over the tailscale-serve HTTPS
 * proxy without reopening fix-round finding 1 for arbitrary tailnet browsers.
 */
async function SessionTokenShim() {
  const headerList = await headers();
  const host = headerList.get("host");
  if (!isLoopbackHost(host)) {
    // Non-loopback Host: only a paired browser (valid HttpOnly cookie) gets
    // the token; every other tailnet page load renders tokenless as before.
    const pairingCookie = (await cookies()).get(PHONE_BROWSER_COOKIE_NAME)?.value;
    if (!verifyPhoneBrowserCookieValue(pairingCookie)) return null;
  }

  const token = getSessionToken();
  const js = `(function(){
    var t=${JSON.stringify(token)};
    var f=window.fetch;
    window.fetch=function(input,init){
      try{
        var url=typeof input==="string"?input:(input&&input.url)||"";
        var apiPath=url.indexOf("/api/")===0||url.indexOf(location.origin+"/api/")===0;
        if(apiPath){
          init=init||{};
          var h=new Headers(init.headers||(typeof input!=="string"&&input.headers)||undefined);
          if(!h.has("x-vidi-session-token"))h.set("x-vidi-session-token",t);
          init.headers=h;
          if(typeof input!=="string")input=new Request(input,init);
        }
      }catch(e){}
      return f.call(this,input,init);
    };
  })();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}

/**
 * Frost appearance: apply the persisted System/Light/Dark choice BEFORE first
 * paint so the page never flashes the wrong theme. `vidi:appearance` is
 * "light" | "dark" | "system" (default). Explicit choices set data-theme on
 * <html>; "system" (or none) removes it so globals.css's prefers-color-scheme
 * media query governs and reacts live to OS changes. Runs in <head>, entirely
 * independent of the SessionTokenShim (which stays in <body>, Host-gated).
 */
const THEME_INIT = `(function(){try{var c=localStorage.getItem("vidi:appearance");var e=document.documentElement;if(c==="light"||c==="dark"){e.setAttribute("data-theme",c);}else{e.removeAttribute("data-theme");}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        {await SessionTokenShim()}
        {children}
      </body>
    </html>
  );
}
