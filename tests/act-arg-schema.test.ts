import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Batch A items 1 + 9 + 10 — the model-facing truth about act-mode tooling.
 *  - item 1: the JSON arg-key SCHEMAS for email-send/calendar-create/write-file
 *    are published to the model (they were never told the key names, so they
 *    guessed "recipient"/"message"/"title" and shipped broken actions).
 *  - item 9: the addendum no longer steers the model into the non-existent
 *    send-message verb.
 *  - item 10: the persona no longer claims raw node/python3 are allowed prefixes
 *    (both were removed from the Bash allowlist).
 */

const { ACT_SYSTEM_ADDENDUM, ACT_ALLOWED_TOOLS } = await import(
  "../lib/providers/claude.ts"
);

const PERSONA = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "VIDI_PERSONA.md"),
  "utf8"
);

test("item 1: the addendum publishes the exact arg-key schemas", () => {
  assert.match(ACT_SYSTEM_ADDENDUM, /email-send \{to/);
  assert.match(ACT_SYSTEM_ADDENDUM, /cc\?, bcc\?/);
  assert.match(ACT_SYSTEM_ADDENDUM, /calendar-create \{summary, start, end\}/);
  assert.match(ACT_SYSTEM_ADDENDUM, /write-file \{path, content\}/);
});

test("item 9: the addendum no longer routes the model to send-message", () => {
  assert.doesNotMatch(ACT_SYSTEM_ADDENDUM, /send-message/);
  assert.match(ACT_SYSTEM_ADDENDUM, /message is NOT available yet/i);
  // Persona says messaging isn't built yet, and drops send-message from the
  // risky-verb list.
  assert.match(PERSONA, /not available yet/i);
});

test("item 10: neither the addendum nor the persona claims node/python3 are allowed", () => {
  // The persona's allowlist line must not name node/python3 (they're gone from
  // ACT_ALLOWED_TOOLS). The only surviving mentions are the secret-guard "no
  // `node -e` one-liners" warning — assert the allowlist itself is clean.
  assert.ok(!ACT_ALLOWED_TOOLS.split(",").some((r) => /^Bash\(node\b/.test(r)));
  assert.ok(!ACT_ALLOWED_TOOLS.split(",").some((r) => /^Bash\(python3?\b/.test(r)));
  // The persona's "limited to safe command prefixes (…)" line no longer lists
  // node/python3 as allowed prefixes.
  const prefixLine = PERSONA.split("\n").find((l) =>
    l.includes("safe command prefixes")
  );
  assert.ok(prefixLine, "persona should describe the safe command prefixes");
  assert.doesNotMatch(prefixLine!, /\bnode\b/);
  assert.doesNotMatch(prefixLine!, /\bpython3\b/);
});
