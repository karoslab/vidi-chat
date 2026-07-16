import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * P8 finding 3 — the wiring check. write-auth-gate.test.ts pins requireWriteAuth
 * ITSELF (the primitive's verdict per header combination), but it can't prove a
 * given route file actually CALLS it — that's exactly how /api/accounts slipped
 * through two review rounds. This is the cheap static counterpart: walk every
 * app/api/**\/route.ts, find each exported write-verb handler (POST/PUT/PATCH/
 * DELETE), and assert its body calls a WRITE-capable positive-auth gate —
 * requireWriteAuth, or a narrower-but-still-positive gate: verifyControlToken
 * (ops/CLI/agent callers, e.g. /api/control, /api/push, /api/confirm/request)
 * or verifyPhoneToken (the paired-phone surface, /api/phone/ask). A handler
 * with NONE of these — the sameOriginOk-alone shape this whole P8 wave closed
 * — fails the test by name, so the next forgotten gate is caught here instead
 * of in a fresh-context review round.
 *
 * 2026-07-07 tightening (fresh-context review of the phone-read PR): this test
 * originally ALSO accepted requireReadAuth as a positive gate for write verbs
 * ("its requireReadAuth twin — same token check, used by e.g. POST
 * /api/threads which mirrors its own GET"). That was sound only while the two
 * gates were token-identical. The moment requireReadAuth gained the phone
 * token, the read-gated POST /api/threads silently inherited a write grant —
 * and this test, by design, could not see it. Now: requireReadAuth alone on a
 * mutating verb FAILS by name unless the handler is listed in
 * READ_GATED_WRITE_EXCEPTIONS with a written justification.
 *
 * Deliberately NOT a full parser: route handlers in this codebase are always
 * top-level `export (async )?function VERB(...)` declarations, one per verb,
 * so slicing the source between consecutive handler-start matches (or EOF for
 * the last one) reliably isolates each handler's body text.
 */

const API_ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "app", "api");

const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HANDLER_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
// Any ONE of these calls present in a write handler's body counts as "gated".
// requireReadAuth is deliberately NOT here — it admits the read-only phone
// token, so on a mutating verb it is a leak, not a gate (see file header).
const WRITE_GATE_RE = /(requireWriteAuth|verifyControlToken|verifyPhoneToken)\s*\(/;
const READ_GATE_RE = /requireReadAuth\s*\(/;

/**
 * Mutating handlers allowed to gate on requireReadAuth ONLY. Empty on purpose:
 * no such route legitimately exists today. Adding one requires writing down,
 * here, why granting the READ-ONLY phone token that mutation is safe.
 * Format: "<file relative to app/api> <METHOD>", e.g. "threads/route.ts POST".
 */
const READ_GATED_WRITE_EXCEPTIONS = new Set<string>([]);

function findRouteFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(findRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

interface WriteHandler {
  file: string; // relative to app/api, for readable failure messages
  method: string;
  body: string;
}

function collectWriteHandlers(): WriteHandler[] {
  const handlers: WriteHandler[] = [];
  for (const file of findRouteFiles(API_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const matches = [...src.matchAll(HANDLER_RE)];
    for (let i = 0; i < matches.length; i++) {
      const method = matches[i][1];
      if (!WRITE_VERBS.has(method)) continue;
      const start = matches[i].index!;
      const end = i + 1 < matches.length ? matches[i + 1].index! : src.length;
      handlers.push({
        file: path.relative(API_ROOT, file),
        method,
        body: src.slice(start, end),
      });
    }
  }
  return handlers;
}

const writeHandlers = collectWriteHandlers();

test("at least the routes this P8 wave touched were found by the walker", () => {
  // A sanity floor, not an exact count — new routes are fine (they still must
  // pass the per-handler test below); this just guards against the walker
  // silently finding zero files from a path typo.
  assert.ok(
    writeHandlers.length >= 20,
    `expected to find >=20 write handlers under app/api, found ${writeHandlers.length}`
  );
});

for (const { file, method, body } of writeHandlers) {
  const key = `${file} ${method}`;

  test(`${key}: calls a WRITE-capable positive auth gate (not sameOriginOk alone, not requireReadAuth)`, () => {
    if (READ_GATED_WRITE_EXCEPTIONS.has(key)) {
      // Allowlisted: still must carry at least the read gate, or it's fully open.
      assert.match(
        body,
        READ_GATE_RE,
        `${key} is in READ_GATED_WRITE_EXCEPTIONS but has no requireReadAuth call either`
      );
      return;
    }
    assert.match(
      body,
      WRITE_GATE_RE,
      `${key} has no requireWriteAuth/verifyControlToken/verifyPhoneToken call in its ` +
        `body. Two ways to get here, both leaks: (a) no positive gate at all — the ` +
        `sameOriginOk-only gap the P8 wave closed; (b) requireReadAuth alone — which ` +
        `since 2026-07-07 admits the READ-ONLY phone token and must not gate a ` +
        `mutation (this is exactly how POST /api/threads briefly inherited phone ` +
        `thread-creation). Wire requireWriteAuth (or verifyControlToken/` +
        `verifyPhoneToken for a narrower caller class), or — only with a written ` +
        `justification — add "${key}" to READ_GATED_WRITE_EXCEPTIONS.`
    );
  });
}

test("READ_GATED_WRITE_EXCEPTIONS entries all correspond to real handlers", () => {
  // A stale allowlist entry (route renamed/deleted) would silently widen the
  // next route that happens to take the freed name — fail it here instead.
  const keys = new Set(writeHandlers.map((h) => `${h.file} ${h.method}`));
  for (const exception of READ_GATED_WRITE_EXCEPTIONS) {
    assert.ok(keys.has(exception), `stale allowlist entry: ${exception}`);
  }
});
