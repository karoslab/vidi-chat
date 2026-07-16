/**
 * Secret redaction for on-disk writes that can leak into egress paths
 * (Tier-2 S-redact). The journal (data/journal.jsonl), the shared fleet memory
 * (data/memory.jsonl, ingested into gbrain), and the Brain notes rememberNote
 * writes all persist model/tool-derived text that CAN carry a secret — a tool
 * result that echoed an Authorization header, a command the model logged with a
 * key in it, or one of vidi's own bearer tokens. gbrain then syncs Brain, and
 * the journal is readable by the browser. Scrub known secret shapes before the
 * write so a secret never lands where it can be exfiltrated or synced out.
 *
 * Two layers:
 *   1. This machine's OWN live tokens (session/control/phone/hands), read from
 *      data/ at redact time and string-replaced exactly — the highest-value
 *      leak, and the one a pattern might miss (a base64url control token has no
 *      distinctive prefix).
 *   2. Generic secret-shaped patterns (Bearer, sk-/AKIA/ghp_/xox…, key=value).
 *
 * Redaction is fail-open on its own errors (reading a token file can throw): a
 * redaction failure must never break a turn, and a missed redaction is no worse
 * than today's behavior. It replaces with a fixed marker, never drops the whole
 * string, so the note/journal stays legible.
 */

import fs from "node:fs";
import { dataPath } from "./data-dir.ts";

const MARKER = "[REDACTED]";

/** The repo's own per-install token files, whose exact contents must never
 *  appear in a persisted write. */
const OWN_TOKEN_FILES = [
  "session-token",
  "control-token",
  "phone-token",
  "hands-token",
  "phone-browser-cookie",
  "phone-pairing-code",
  "ntfy-topic",
  ".proxy-secret",
];

function ownTokenValues(): string[] {
  const values: string[] = [];
  for (const name of OWN_TOKEN_FILES) {
    try {
      const v = fs.readFileSync(dataPath(name), "utf8").trim();
      // Only redact non-trivial secrets — a 1-2 char file would nuke the text.
      if (v.length >= 8) values.push(v);
    } catch {
      /* file may not exist (never materialized) — skip */
    }
  }
  return values;
}

/** Generic secret-shaped patterns. Each captures a leading label group it
 *  preserves so the redaction is legible ("Authorization: [REDACTED]"). */
const PATTERNS: { re: RegExp; replace: string }[] = [
  // Authorization: Bearer <token>  /  Bearer <token>
  { re: /\b(bearer)\s+[A-Za-z0-9._\-]{12,}/gi, replace: `$1 ${MARKER}` },
  // Vidi's own proxy/header secret names → value (header or json field).
  {
    re: /\b(x-vidi-(?:key|phone-token|control-token|session-token|hands-token))["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/gi,
    replace: `$1: ${MARKER}`,
  },
  // OpenAI / Anthropic style keys: sk-…, sk-ant-…
  { re: /\bsk-(?:ant-)?[A-Za-z0-9._\-]{16,}/g, replace: MARKER },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: MARKER },
  // GitHub tokens (personal/oauth/server/refresh/fine-grained).
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: MARKER },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, replace: MARKER },
  // Google API key.
  { re: /\bAIza[0-9A-Za-z._\-]{35}\b/g, replace: MARKER },
  // Generic labelled secret: api_key / apikey / token / secret / password = <value>
  {
    re: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{8,}/gi,
    replace: `$1: ${MARKER}`,
  },
];

/**
 * Redact secrets from a string bound for a persisted/egress-able write.
 * Non-strings and empty strings pass through untouched.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  try {
    for (const value of ownTokenValues()) {
      out = out.split(value).join(MARKER);
    }
  } catch {
    /* fail-open: never break a write over redaction */
  }
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-redact every string in a JSON-shaped value (P8 finding 4 — the P7
 * re-audit's confirm-payload exfil gap). A parked confirm action's `payload`
 * (an email body, a write-file's content, a calendar summary) is dispatched to
 * its executor with only a short spoken/visual DESCRIPTION shown at approval —
 * the full body is never surfaced. So an act-mode agent that read a live secret
 * could smuggle it into the unshown body and exfiltrate it past the human "yes"
 * (gws-email → Google, write-file → disk). Scrubbing known secret shapes + this
 * machine's own live tokens out of the payload before executor dispatch closes
 * that: an approved action can carry the user's intended text but never a live
 * credential. Recurses objects/arrays; non-string leaves pass through unchanged.
 * Fail-open per-string via redactSecrets; benign content is untouched in meaning.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
