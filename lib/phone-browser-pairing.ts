import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import crypto from "node:crypto";

/**
 * Phone-BROWSER pairing (the tailnet web-UI counterpart of lib/phone-token.ts).
 *
 * Why this exists: the Tier-2 fix round Host-gated app/layout.tsx's
 * SessionTokenShim, so a page served with a ts.net Host ships NO session token
 * — correct against an arbitrary tailnet browser, but it also bricked the one
 * tailnet browser we WANT working: the owner's phone over the tailscale-serve
 * HTTPS proxy (every UI fetch 401s into empty state). The gate must
 * distinguish "a browser that proved it belongs to this install" from "any
 * device that can reach the proxy" — Host alone cannot.
 *
 * Mechanism: a ONE-TIME, short-TTL pairing code (minted only by a
 * control-token caller, i.e. ops on this machine) is opened once on the phone
 * as GET /pair?code=…; consuming it sets a long-lived HttpOnly cookie whose
 * value is this install's phone-browser secret. app/layout.tsx then injects
 * the session shim when the request Host is loopback OR the cookie verifies.
 * The API auth model is unchanged — routes still require the session token
 * header; pairing only decides who receives the shim that carries it.
 *
 * Files (both 0600, gitignored under data/, listed in lib/redact.ts):
 *   data/phone-pairing-code   — the pending one-time code (bare token, no
 *                               JSON: the redactor matches whole trimmed file
 *                               contents). Expiry = file mtime + TTL. Deleted
 *                               on successful consume and on expired attempt.
 *   data/phone-browser-cookie — the long-lived cookie secret (same lazy
 *                               materialization as session/phone tokens).
 */

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PHONE_BROWSER_COOKIE_NAME = "vidi-phone-browser";

const pairingCodeFile = () => dataPath("phone-pairing-code");
const cookieSecretFile = () => dataPath("phone-browser-cookie");
// Non-secret witness that a phone actually completed pairing at least once (see
// markPairingConsumed / lastPairingConsumedAtMs). Written on every successful
// consume; read by the Stage-6 "Anna on your phone" journey verify() as the
// mechanical proof a phone browser really connected — not just that a code was
// minted. Bare epoch-ms integer, not a secret, so it needs no redact entry.
const pairingConsumedFile = () => dataPath("phone-pairing-last");

/** Mint (and persist) a fresh one-time pairing code, replacing any pending
 *  one. Returns the code and its absolute expiry for the caller's response. */
export function mintPairingCode(): { code: string; expiresAtEpochMs: number } {
  const code = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(pairingCodeFile()), { recursive: true });
  fs.writeFileSync(pairingCodeFile(), code + "\n", { mode: 0o600 });
  const mintedAtMs = fs.statSync(pairingCodeFile()).mtimeMs;
  return { code, expiresAtEpochMs: Math.round(mintedAtMs + PAIRING_CODE_TTL_MS) };
}

/**
 * Single-use, fail-closed consume. True ONLY when a pending code exists, has
 * not aged past the TTL (file mtime anchors expiry), and the candidate matches
 * in constant time — in which case the pending code is deleted so a replay of
 * the same link fails. A WRONG candidate does not consume the pending code
 * (mistyping must not burn the real link); an EXPIRED file is deleted on
 * sight so it can't linger as a guessing target.
 */
export function consumePairingCode(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  let pending: string;
  let mintedAtMs: number;
  try {
    pending = fs.readFileSync(pairingCodeFile(), "utf8").trim();
    mintedAtMs = fs.statSync(pairingCodeFile()).mtimeMs;
  } catch {
    return false; // nothing pending
  }
  if (!pending) return false;
  if (Date.now() - mintedAtMs > PAIRING_CODE_TTL_MS) {
    try {
      fs.unlinkSync(pairingCodeFile());
    } catch {
      /* already gone */
    }
    return false;
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(pending);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    fs.unlinkSync(pairingCodeFile());
  } catch {
    /* consumed value is already checked; a failed unlink only risks replay
       within the TTL on this machine's own filesystem */
  }
  markPairingConsumed();
  return true;
}

/** Record that a phone completed pairing right now. Best-effort: a failed write
 *  must never turn a genuinely-successful consume into a failure. */
export function markPairingConsumed(): void {
  try {
    fs.mkdirSync(path.dirname(pairingConsumedFile()), { recursive: true });
    fs.writeFileSync(pairingConsumedFile(), String(Date.now()) + "\n", { mode: 0o600 });
  } catch {
    /* the witness is advisory; the pairing itself already succeeded */
  }
}

/** Epoch-ms of the last successful phone pairing, or null if none has happened
 *  on this install. The Stage-6 journey verify() uses this as the proof a phone
 *  browser actually connected. */
export function lastPairingConsumedAtMs(): number | null {
  try {
    const raw = fs.readFileSync(pairingConsumedFile(), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The long-lived cookie secret, materialized lazily like the other tokens. */
export function getPhoneBrowserCookieSecret(): string {
  try {
    const existing = fs.readFileSync(cookieSecretFile(), "utf8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(24).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(cookieSecretFile()), { recursive: true });
    fs.writeFileSync(cookieSecretFile(), secret + "\n", { mode: 0o600 });
  } catch {
    /* if we can't persist, the in-memory value still works this run */
  }
  return secret;
}

/** Constant-time cookie-value check. Missing/mismatched → false (fail closed). */
export function verifyPhoneBrowserCookieValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const expected = getPhoneBrowserCookieSecret();
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The exact `Set-Cookie` header value for the `vidi-phone-browser` cookie —
 * ONE place both mints call, so they can never drift into different cookie
 * shapes:
 *   - `GET /pair` (control-token-minted one-time code — the original
 *     phone-browser path).
 *   - `POST /api/phone/browser-session` (2026-07-10, owner-approved — the
 *     app's ALREADY-HELD phone token mints the SAME cookie directly, no code
 *     round trip; see THREAT_MODEL.md "B7" and lib/origin.ts's
 *     requireWriteAuth doc comment for the security-model rationale).
 */
export function buildPhoneBrowserCookieHeader(): string {
  return [
    `${PHONE_BROWSER_COOKIE_NAME}=${getPhoneBrowserCookieSecret()}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${365 * 24 * 60 * 60}`,
  ].join("; ");
}
