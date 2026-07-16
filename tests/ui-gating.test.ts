import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowFleet,
  advancedCollapsedByDefault,
  showAdvancedDisclosure,
} from "../lib/ui-gating.ts";

/**
 * Pure UI-gating decisions (owner vs a non-technical second user). No React
 * harness exists in this repo, so the branch logic behind the composer's
 * "Advanced" disclosure and the Fleet/swarm visibility is extracted here and
 * unit-tested directly. The load-bearing invariant is that the OWNER install
 * looks EXACTLY as today — so every function must return the owner-preserving
 * value when ownerInstall is true.
 */

test("shouldShowFleet: owner sees Fleet + swarm panels, non-owner does not", () => {
  assert.equal(shouldShowFleet(true), true);
  assert.equal(shouldShowFleet(false), false);
});

test("advancedCollapsedByDefault: collapsed for non-owner, expanded for owner", () => {
  assert.equal(advancedCollapsedByDefault(false), true, "non-owner starts collapsed");
  assert.equal(advancedCollapsedByDefault(true), false, "owner stays flat/expanded");
});

test("showAdvancedDisclosure: only the non-owner gets the disclosure wrapper", () => {
  assert.equal(showAdvancedDisclosure(false), true, "non-owner controls sit under Advanced");
  assert.equal(showAdvancedDisclosure(true), false, "owner renders them flat, as today");
});

test("owner path is byte-identical to today (flat, everything visible)", () => {
  // The three functions, read together, are what the owner sees: fleet on,
  // controls flat (no disclosure), nothing collapsed.
  assert.equal(shouldShowFleet(true), true);
  assert.equal(showAdvancedDisclosure(true), false);
  assert.equal(advancedCollapsedByDefault(true), false);
});
