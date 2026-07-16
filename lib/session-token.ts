import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import crypto from "node:crypto";

/**
 * Browser-UI session token (Tier-2 tailnet hardening). Once `tailscale serve`
 * proxies the tailnet to this loopback server, an Origin/Host CSRF check can no
 * longer tell a genuinely-local request from a tailnet one: the proxy speaks to
 * 127.0.0.1 and a raw-TCP tailnet client can forge `Host: 127.0.0.1:4183` with
 * no Origin, so it passes sameOriginOk(). The only thing a remote tailnet peer
 * cannot obtain is a secret read from this machine's local filesystem.
 *
 * This token is that secret. It is materialized in data/session-token (0600,
 * gitignored under data/) and injected into the served HTML at render time
 * (app/layout.tsx reads it server-side) so the local browser attaches it as the
 * x-vidi-session-token header on same-origin fetches. A tailnet browser that
 * loads the same page over the proxy ALSO receives the injected token, so this
 * does not by itself distinguish a tailnet browser — the operational fix for
 * that residual is to drop the raw-TCP `serve --tcp 4183` forward and keep only
 * the HTTPS proxy (whose ts.net Host the origin guard's loopback allowlist
 * already rejects). What the session token DOES buy: it lets us require a
 * positive credential on the read/config routes the browser uses, closing the
 * forged-loopback-Host raw-TCP door for every native/ops caller that is not the
 * same-machine Swift app (which stays on the sameOriginOk path until it can be
 * rebuilt to send this header).
 *
 * Distinct file + header from control/phone tokens so a leak is scoped: the
 * session token grants only the browser read/config surface, never the control
 * plane or the phone push path.
 */

const tokenFile = () => dataPath("session-token");

export function getSessionToken(): string {
  try {
    const existing = fs.readFileSync(tokenFile(), "utf8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), token + "\n", { mode: 0o600 });
  } catch {
    /* if we can't persist, the in-memory value still works this run */
  }
  return token;
}

/** Constant-time header check. Missing/mismatched → false (fail closed). */
export function verifySessionToken(req: Request): boolean {
  const header = req.headers.get("x-vidi-session-token");
  if (!header) return false;
  const expected = getSessionToken();
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
