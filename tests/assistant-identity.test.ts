import { test } from "node:test";
import assert from "node:assert/strict";

import { ASSISTANT_NAME, ASSISTANT_MONOGRAM } from "../lib/assistant-identity.ts";

/**
 * Vidi's identity is fixed (product ruling 2026-07-05) — the single source of
 * truth every surface imports is the constant name/monogram, never a
 * user-editable value.
 */

test("the assistant name is the fixed 'Vidi'", () => {
  assert.equal(ASSISTANT_NAME, "Vidi");
});

test("the assistant monogram is the fixed 'V'", () => {
  assert.equal(ASSISTANT_MONOGRAM, "V");
});
