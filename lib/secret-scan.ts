import fs from "node:fs";
import path from "node:path";

/**
 * Pre-push secret gate for the "Your GitHub" backup path (Journey Stage 4).
 *
 * Vidi backs the customer's memory up to a private GitHub repo. That memory is
 * a folder of notes the customer never audits line-by-line, so it CAN pick up a
 * pasted password, an API key echoed into a note, or a stray `.env`. This gate
 * runs before EVERY push we own (see lib/github-connect.ts pushWikiBackup) and
 * BLOCKS the push if any outgoing file looks like it holds a credential —
 * reporting the file and line in plain words so the customer can remove it.
 *
 * It is deliberately a DETECT-AND-BLOCK gate, not a redactor (that is
 * lib/redact.ts's job for on-disk egress writes). A backup must be an exact copy
 * or it is not a backup; so when we find a secret we stop and ask the human to
 * take it out, we never silently rewrite their file.
 *
 * Pure + exported so the patterns are unit-testable without a real repo.
 */

/** One credential-shaped hit, with a message in CUSTOMER words — plain language
 *  a non-technical person understands (no "repo", "token", "regex"). */
export interface SecretFinding {
  /** Path shown to the customer — relative to the backup folder when scanning a
   *  tree, or whatever caller-supplied label for a raw-text scan. */
  file: string;
  /** 1-based line number the credential shape starts on. */
  line: number;
  /** Internal classification, for tests/logs — never shown to the customer. */
  kind: string;
  /** Plain-language sentence safe to show the customer. */
  message: string;
}

const CUSTOMER_MESSAGE = "A file looks like it contains a password or key.";

/**
 * The credential shapes we block on. Each is matched per line; a private-key
 * BEGIN marker anchors a multi-line key to the line it opens on. Kept in step
 * with lib/redact.ts's PATTERNS (same shapes) but line-oriented and reported,
 * not rewritten.
 */
const LINE_PATTERNS: { kind: string; re: RegExp }[] = [
  // PEM private keys (RSA/EC/OPENSSH/PGP/DSA/plain) — the highest-value leak.
  { kind: "private-key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  // AWS access key id.
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub tokens (personal/oauth/server/refresh/fine-grained).
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  // GitHub fine-grained PAT.
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  // OpenAI / Anthropic style keys: sk-…, sk-ant-…
  { kind: "api-key", re: /\bsk-(?:ant-)?[A-Za-z0-9._-]{16,}\b/ },
  // Stripe live secret key.
  { kind: "api-key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  // Slack tokens.
  { kind: "api-key", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  // Google API key.
  { kind: "api-key", re: /\bAIza[0-9A-Za-z._-]{35}\b/ },
  // Authorization: Bearer <token>.
  { kind: "bearer-token", re: /\bbearer\s+[A-Za-z0-9._-]{16,}/i },
  // Labelled secret assignment: api_key/token/secret/password = <value>.
  {
    kind: "labelled-secret",
    re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{8,}/i,
  },
];

/**
 * A `.env`-style `KEY=long-secret` line: an UPPER_SNAKE name assigned a long,
 * space-free value. Required to look like a credential (secret-ish name OR a
 * high-entropy value) so a plain `TITLE=Some Long Sentence Here` in a note is
 * not blocked — a false block stops a legitimate backup, so this one rule is
 * conservative on purpose. The labelled-secret pattern above already covers the
 * obvious `PASSWORD=` cases; this adds the bare `AKIA…`-free env dumps.
 */
const ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*["']?([A-Za-z0-9._\-/+]{16,})["']?\s*$/;
const ENV_SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|ACCESS|API)/;

/** A value that mixes letters and digits and is reasonably long reads as a
 *  credential rather than prose/a URL slug. */
function looksHighEntropy(value: string): boolean {
  return value.length >= 24 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function envLineIsSecret(line: string): boolean {
  const m = ENV_LINE.exec(line);
  if (!m) return false;
  const [, name, value] = m;
  return ENV_SECRET_NAME.test(name) || looksHighEntropy(value);
}

/**
 * Scan a block of text for credential shapes. `file` is the label attached to
 * each finding. Returns every distinct line that hit (one finding per hitting
 * line, first matching kind wins for that line).
 */
export function scanText(text: string, file = ""): SecretFinding[] {
  if (typeof text !== "string" || !text) return [];
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let kind: string | null = null;
    for (const p of LINE_PATTERNS) {
      if (p.re.test(line)) {
        kind = p.kind;
        break;
      }
    }
    if (!kind && envLineIsSecret(line)) kind = "env-secret";
    if (kind) {
      findings.push({ file, line: i + 1, kind, message: CUSTOMER_MESSAGE });
    }
  }
  return findings;
}

// Files we never scan: the git plumbing, dependency trees, and anything that
// reads as binary. Skipping keeps a big backup fast and avoids false hits on
// compiled blobs.
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 2 MB — notes are text; skip larger blobs.

/** Heuristic: a NUL byte in the first chunk means binary, skip it. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk a directory and scan every text file for credential shapes. Findings'
 * `file` is the path RELATIVE to `root`, so the message names the file the way
 * the customer sees it in their folder. The scan is best-effort: an unreadable
 * file is skipped (never throws), because the gate must fail toward "let me look
 * again", not crash the backup. Blocking is the caller's decision on a non-empty
 * result.
 */
export function scanTreeForSecrets(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_SCAN_BYTES) continue;
        const buf = fs.readFileSync(abs);
        if (looksBinary(buf)) continue;
        const rel = path.relative(root, abs);
        for (const f of scanText(buf.toString("utf8"), rel)) findings.push(f);
      } catch {
        /* unreadable file — skip, never throw */
      }
    }
  };
  walk(root);
  return findings;
}

/**
 * One customer-facing sentence summarising a block of findings, for the API /
 * UI. Names up to the first two files so the customer knows where to look
 * without a wall of paths.
 */
export function describeFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return "";
  const files = [...new Set(findings.map((f) => f.file).filter(Boolean))];
  const where =
    files.length === 0
      ? ""
      : files.length <= 2
        ? ` (in ${files.join(" and ")})`
        : ` (in ${files.slice(0, 2).join(", ")} and ${files.length - 2} more)`;
  return `${CUSTOMER_MESSAGE}${where} Please remove it, then try the backup again.`;
}
