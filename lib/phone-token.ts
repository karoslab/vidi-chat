import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import crypto from "node:crypto";

/**
 * Phone auth for /api/phone/ask (Workstream C5). The phone Shortcut sends this
 * per-install token in the x-vidi-phone-token header so the phone endpoint
 * isn't open on the LAN/tunnel. Same shape as lib/control.ts's control token,
 * but a distinct file+header so a leaked phone token can't drive the control
 * plane. 32 hex chars (16 random bytes) — easy to paste into a Shortcut.
 *
 * Materialized lazily on first read AND eagerly at server boot (instrumentation
 * register()), so the file exists before the user needs to copy it.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/phone-token.
const tokenFile = () => dataPath("phone-token");

export function getPhoneToken(): string {
  try {
    const existing = fs.readFileSync(tokenFile(), "utf8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(16).toString("hex"); // 32 hex chars
  try {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), token + "\n", { mode: 0o600 });
  } catch {
    /* if we can't persist, the in-memory value still works this run */
  }
  return token;
}

/** Constant-time header check. Missing/mismatched header → false (fail closed
 *  on auth, unlike the fail-open data reads elsewhere: this is the gate). */
export function verifyPhoneToken(req: Request): boolean {
  const header = req.headers.get("x-vidi-phone-token");
  if (!header) return false;
  const expected = getPhoneToken();
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
