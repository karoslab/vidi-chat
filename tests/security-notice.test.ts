import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECURITY_NOTICE_ACK_LABEL,
  securityNoticeSections,
  SECURITY_NOTICE_TITLE,
} from "../lib/security-notice.ts";

/**
 * T2.3 — the security-notice content is a reviewable constant (the owner
 * edits the wording). These tests pin the load-bearing properties, not the
 * exact prose:
 *   - it's ONE screen's worth of grouped, plain-language content,
 *   - it enumerates capabilities derived from the CODE (jail dirs, confirm-
 *     before-risky, mic/screen only via the companion app, what goes to
 *     Anthropic/OpenAI),
 *   - it never leaks raw internals or legalese.
 *
 * V2 second-user track: the notice now has TWO audience variants — an OWNER
 * install (the owner can flip Plan→Auto themselves; voice is live) and a
 * NON-owner install (Plan-clamped) — selected by
 * securityNoticeSections(ownerInstall). Every shared invariant here runs
 * against BOTH variants.
 *
 * The step ORDERING (notice shown BEFORE the permissions walkthrough) is
 * enforced structurally in Onboarding.tsx: the notice is step 3 and the
 * permissions walkthrough is step 4. This suite guards the content that screen
 * renders; the ordering is a fixed step index in the component.
 */

const VARIANTS = [
  { label: "owner", sections: securityNoticeSections(true) },
  { label: "non-owner", sections: securityNoticeSections(false) },
] as const;

for (const { label, sections } of VARIANTS) {
  const allText = sections
    .flatMap((s) => [s.heading, ...s.points])
    .join(" \n ")
    .toLowerCase();

  test(`[${label}] has a title and a small number of grouped sections (one screen)`, () => {
    assert.ok(SECURITY_NOTICE_TITLE.trim().length > 0);
    assert.ok(sections.length >= 3 && sections.length <= 5);
    for (const section of sections) {
      assert.ok(section.heading.trim().length > 0);
      assert.ok(section.points.length > 0);
      for (const point of section.points) assert.ok(point.trim().length > 0);
    }
  });

  test(`[${label}] covers what Vidi can SEE — files + the mic/screen companion-app boundary`, () => {
    assert.match(allText, /file/);
    // Mic/screen only via the separate Mac companion app, never this chat.
    assert.match(allText, /microphone|mic/);
    assert.match(allText, /screen/);
    assert.match(allText, /app on your mac|companion|separate/);
  });

  test(`[${label}] covers what Vidi can DO — read + Auto-mode writes to the jail dirs`, () => {
    assert.match(allText, /read/);
    assert.match(allText, /auto mode/);
    assert.match(allText, /workspace/);
    assert.match(allText, /desktop/);
    assert.match(allText, /downloads/);
  });

  test(`[${label}] covers what Vidi can't do — confirm-before-risky + secrets walled off`, () => {
    assert.match(allText, /delete|deploy|spend|money/);
    // The confirm-before-acting promise.
    assert.match(allText, /ask/);
    // Secrets are off-limits.
    assert.match(allText, /password|secret|key/);
  });

  test(`[${label}] names where information goes — the user's own account, Anthropic/OpenAI`, () => {
    assert.match(allText, /claude|codex/);
    assert.match(allText, /anthropic/);
    assert.match(allText, /openai/);
    // The no-telemetry promise.
    assert.match(allText, /tracking|analytics/);
  });

  test(`[${label}] no leaked internals or legalese`, () => {
    // No raw code identifiers / flags / stderr shapes in user-facing copy.
    assert.doesNotMatch(allText, /workspace_root|--add-dir|enoent|vidi-act|stderr|process\.env/);
    // No legalese boilerplate.
    assert.doesNotMatch(allText, /hereby|liability|warrant|indemnif|terms of service/);
  });
}

test("the acknowledgment button is comprehension-framed, not a Got-it dismissal", () => {
  // W3 — the notice is a plain-language overview, so the button reads as
  // understanding it, not casually dismissing it. Kept as one constant so the
  // wording is a one-line change.
  assert.equal(SECURITY_NOTICE_ACK_LABEL, "I understand");
});
