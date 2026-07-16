import { test } from "node:test";
import assert from "node:assert/strict";

// Lock the act-mode permission policy (the owner's standing rule 2026-07-05):
// gh is allowed so the branch→PR workflow works headless, and direct pushes
// to master/main are mechanically denied — work lands via feature branch + PR.
const { ACT_ALLOWED_TOOLS, ACT_DISALLOWED_TOOLS } = await import(
  "../lib/providers/claude.ts"
);

test("act mode allows git and gh so branch→PR works headless", () => {
  const allowed = ACT_ALLOWED_TOOLS.split(",");
  assert.ok(allowed.includes("Bash(git *)"));
  assert.ok(allowed.includes("Bash(gh *)"));
});

test("act mode denies direct pushes to master/main in every common form", () => {
  const denied = ACT_DISALLOWED_TOOLS.split(",");
  for (const rule of [
    "Bash(git push)",
    "Bash(git push origin main*)",
    "Bash(git push origin master*)",
    "Bash(git push -u origin main*)",
    "Bash(git push -u origin master*)",
    "Bash(git push -f*)",
    "Bash(git push --force*)",
    "Bash(git push origin HEAD:main*)",
    "Bash(git push origin HEAD:master*)",
  ]) {
    assert.ok(denied.includes(rule), `missing deny rule: ${rule}`);
  }
});

test("act mode denies the dangerous gh verbs the broad allow would admit", () => {
  const denied = ACT_DISALLOWED_TOOLS.split(",");
  for (const rule of [
    "Bash(gh auth token*)",
    "Bash(gh repo delete*)",
    "Bash(gh secret*)",
    "Bash(gh pr merge*)",
    "Bash(gh api*)",
  ]) {
    assert.ok(denied.includes(rule), `missing deny rule: ${rule}`);
  }
});
