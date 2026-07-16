import { test } from "node:test";
import assert from "node:assert/strict";

import { validateCustomAgentName } from "../lib/agent-name-input.ts";

/**
 * T1.2 — custom agent-name validation. The picker validates a free-text name
 * against exactly what the fleet manager's pickName() will store (letters only,
 * title-cased) so the user is never surprised by a silently reshaped name. A
 * curated stack name (already clean) passes with no note; a custom name is
 * checked and, when reshaped, surfaced plainly.
 */

test("empty input is ok (optional field → backend picks a curated name)", () => {
  const v = validateCustomAgentName("");
  assert.equal(v.ok, true);
  assert.equal(v.cleaned, "");
  assert.equal(v.note, null);
});

test("whitespace-only input is treated as empty/optional", () => {
  const v = validateCustomAgentName("   ");
  assert.equal(v.ok, true);
  assert.equal(v.cleaned, "");
  assert.equal(v.note, null);
});

test("a clean curated name passes with no note (e.g. a Kannada stack's Roman name)", () => {
  // The Kannada stack stores the Roman callsign ("Garuda") as name; the script
  // is display-only, so the stored value is already clean.
  for (const cleanName of ["Garuda", "Jarvis", "Athena", "Saraswati"]) {
    const v = validateCustomAgentName(cleanName);
    assert.equal(v.ok, true, `${cleanName} should be ok`);
    assert.equal(v.cleaned, cleanName);
    assert.equal(v.note, null, `${cleanName} should need no note`);
  }
});

test("a custom name with no letters is rejected with a plain-language note", () => {
  const v = validateCustomAgentName("123 -- !!");
  assert.equal(v.ok, false);
  assert.equal(v.cleaned, "");
  assert.ok(v.note && v.note.length > 0);
});

test("a custom name with strippable chars is ok but shows what it becomes", () => {
  // Digits/hyphens are dropped, letters title-cased → "Zoe".
  const v = validateCustomAgentName("zoe-2");
  assert.equal(v.ok, true);
  assert.equal(v.cleaned, "Zoe");
  assert.ok(v.note && v.note.includes("Zoe"));
});

test("a lowercase all-letters name is ok and title-cased with no surprise note", () => {
  // Case-only change is not a surprise worth a note (matches backend behavior).
  const v = validateCustomAgentName("scout");
  assert.equal(v.ok, true);
  assert.equal(v.cleaned, "Scout");
  assert.equal(v.note, null);
});
