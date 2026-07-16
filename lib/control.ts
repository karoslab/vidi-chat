import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./data-dir.ts";
import crypto from "node:crypto";

/**
 * Control-plane auth. The control API (agents calling back to spawn siblings,
 * share memory, start servers — CNVS's cnvsctl analog) is reachable only with
 * a per-install token stored in data/.control-token (gitignored under data/).
 * vidictl reads the same file (it runs as the owner on the same box), so no env
 * injection is needed. Loopback + token = defense in depth over the origin
 * guard the browser routes use.
 */

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/control-token.
const tokenFile = () => dataPath("control-token");

export function getControlToken(): string {
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

export function verifyControlToken(req: Request): boolean {
  const header = req.headers.get("x-vidi-control-token");
  if (!header) return false;
  const expected = getControlToken();
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
