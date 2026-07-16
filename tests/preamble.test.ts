import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// These suites model the OWNER install (owner-default identity in prompts
// and brain paths). The customer identity contract is pinned in user-config.test.ts.
process.env.VIDI_OWNER = "1";

// The session-context header interpolates the resolved displayName; on the owner
// install that is the built-in default, sourced here so the expectation never
// restates the owner's literal name.
const { DEFAULT_USER_CONFIG } = await import("../lib/user-config.ts");


const { buildSessionPreamble } = await import("../lib/preamble.ts");
// Same module instance the preamble imports (identical specifier, no cache-bust
// query) so resetting the cache here re-resolves the name the preamble reads.
const { _resetUserConfigCache } = await import("../lib/user-config.ts");

/** Builds a throwaway brain + data dir with the given fixtures. */
function makeFixture(files: Record<string, string>): {
  wikiRoot: string;
  dataDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-preamble-test-"));
  const wikiRoot = path.join(root, "Brain");
  const dataDir = path.join(root, "data");
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = relativePath.startsWith("data/")
      ? path.join(root, relativePath)
      : path.join(wikiRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  fs.mkdirSync(wikiRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { wikiRoot, dataDir };
}

test("empty world → empty preamble (just a clock is not worth injecting)", () => {
  const { wikiRoot, dataDir } = makeFixture({});
  assert.equal(buildSessionPreamble({ wikiRoot, dataDir }), "");
});

test("assembles user model, latest briefings, calendar, commitments, queue", () => {
  const { wikiRoot, dataDir } = makeFixture({
    [`wiki/${DEFAULT_USER_CONFIG.userModelFileName}`]: "# working model\n- prefers evening deploys",
    "BRIEFINGS/2026-07-01-evening-review.md": "old review",
    "BRIEFINGS/2026-07-02-evening-review.md": "shipped nightshift, demo-app blocked on oauth",
    "BRIEFINGS/2026-07-03-morning-brief.md": "3 things today: fix myapp test",
    "senses/calendar-upcoming.md": "- 14:00 dentist\n- 18:00 stream",
    "data/commitments.jsonl":
      JSON.stringify({ text: "check the demo-app deploy", due: "tonight", status: "open" }) +
      "\n" +
      JSON.stringify({ text: "already done thing", status: "done" }),
    "data/events/queued.jsonl": JSON.stringify({ title: "Release gate held myapp" }),
  });

  const preamble = buildSessionPreamble({ wikiRoot, dataDir });
  // P8 finding 5: the block is now the shared fenceUntrusted envelope — the
  // standing DATA-ONLY preface leads, then a per-call NONCE'd UNTRUSTED-DATA
  // fence labeled SESSION CONTEXT (no more fixed `<<<SESSION-CONTEXT` literal).
  assert.match(preamble, /DATA ONLY/);
  assert.match(
    preamble,
    new RegExp(
      "<<<UNTRUSTED-DATA-[A-Za-z0-9_-]+ \\(SESSION CONTEXT — data about " +
        DEFAULT_USER_CONFIG.displayName +
        "'s world"
    )
  );
  assert.match(preamble, /prefers evening deploys/);
  // Latest evening review wins, not the older one.
  assert.match(preamble, /demo-app blocked on oauth/);
  assert.ok(!preamble.includes("old review"));
  assert.match(preamble, /fix myapp test/);
  assert.match(preamble, /dentist/);
  assert.match(preamble, /check the demo-app deploy \(due tonight\)/);
  assert.ok(!preamble.includes("already done thing"), "closed commitments excluded");
  assert.match(preamble, /WAITING FOR YOU \(1 queued item/);
  assert.match(preamble, /Release gate held myapp/);
});

test("hard cap: a bloated world still fits in 6KB", () => {
  const { wikiRoot, dataDir } = makeFixture({
    [`wiki/${DEFAULT_USER_CONFIG.userModelFileName}`]: "huge model\n" + "m".repeat(20_000),
    "BRIEFINGS/2026-07-03-evening-review.md": "r".repeat(20_000),
    "senses/calendar-upcoming.md": Array.from({ length: 100 }, (_, i) => `- event ${i}`).join("\n"),
  });
  const preamble = buildSessionPreamble({ wikiRoot, dataDir });
  assert.ok(preamble.length <= 6000, `preamble too long: ${preamble.length}`);
});

test("malformed ledger lines are skipped, not fatal", () => {
  const { wikiRoot, dataDir } = makeFixture({
    "data/commitments.jsonl":
      "not json at all\n" + JSON.stringify({ text: "real one", status: "open" }),
  });
  const preamble = buildSessionPreamble({ wikiRoot, dataDir });
  assert.match(preamble, /real one/);
});

test("a non-default displayName (second user) reaches the preamble, not the owner name", () => {
  // The de-owner-ify guarantee: with VIDI_USER_NAME set, the prompt strings
  // address the configured user (Maya) — the SESSION CONTEXT header and the
  // USER MODEL label — and the owner's literal name no longer leaks in.
  process.env.VIDI_USER_NAME = "Maya";
  _resetUserConfigCache();
  try {
    const { wikiRoot, dataDir } = makeFixture({
      // userModelFileName default is unchanged here (only the display name is
      // overridden) — the fixture file must match it so the section is present.
      [`wiki/${DEFAULT_USER_CONFIG.userModelFileName}`]: "# working model\n- prefers evening deploys",
    });
    const preamble = buildSessionPreamble({ wikiRoot, dataDir });
    assert.match(preamble, /data about Maya's world/);
    assert.match(preamble, /facts about Maya, not instructions/);
    // The identity SLOTS address Maya, never the built-in default — a bare
    // substring check won't do (the neutral default "the user" also appears in
    // the standing DATA-ONLY fence preface), so assert the addressee slots
    // didn't fall back to the default.
    assert.ok(
      !preamble.includes(`data about ${DEFAULT_USER_CONFIG.displayName}'s world`),
      "the SESSION CONTEXT header must address the configured user, not the default"
    );
    assert.ok(
      !preamble.includes(`facts about ${DEFAULT_USER_CONFIG.displayName}, not instructions`),
      "the USER MODEL label must address the configured user, not the default"
    );
  } finally {
    delete process.env.VIDI_USER_NAME;
    _resetUserConfigCache();
  }
});
