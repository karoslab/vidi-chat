import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Tier-2 (B3). Raw `Bash(node *)` and `Bash(python3 *)` are an arbitrary-code
 * escape that defeats the whole prefix allowlist (e.g. `node bin/vidictl.mjs
 * shell "<anything>"` → the control plane's spawn(cmd,{shell:true}) with no
 * confirm). They must be REMOVED from the act-mode allowlist. The action
 * chokepoint (`Bash(vidi-act *)`) and the build/PR workflow (git/gh/npm) must
 * stay. `vidi-act` runs as a PATH command, not via `node`, so removing node
 * does not break it.
 */

const { ACT_ALLOWED_TOOLS } = await import("../lib/providers/claude.ts");
const rules = ACT_ALLOWED_TOOLS.split(",");

test("raw interpreter escapes are removed", () => {
  assert.ok(!rules.includes("Bash(node *)"), "Bash(node *) must be gone");
  assert.ok(!rules.includes("Bash(python3 *)"), "Bash(python3 *) must be gone");
  // No smuggled variant with a different arg glob either.
  assert.ok(
    !rules.some((r) => /^Bash\(node\b/.test(r)),
    "no Bash(node …) variant"
  );
  assert.ok(
    !rules.some((r) => /^Bash\(python3?\b/.test(r)),
    "no Bash(python…) variant"
  );
});

test("the action chokepoint and workflow tools remain", () => {
  assert.ok(rules.includes("Bash(vidi-act *)"), "vidi-act chokepoint stays");
  assert.ok(rules.includes("Bash(git *)"), "git (branch→PR) stays");
  assert.ok(rules.includes("Bash(gh *)"), "gh (PR create) stays");
  assert.ok(rules.includes("Bash(npm *)"), "npm (build) stays");
  // Read-only tools stay.
  assert.ok(rules.includes("Read"));
  assert.ok(rules.includes("Write"));
});
