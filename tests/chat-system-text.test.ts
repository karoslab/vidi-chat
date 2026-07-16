import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Item 4 — the onboarding personality tone is wired into the TEXT-chat path
 * (POST /api/chat), not just voice. chatExtraSystemText() is what the chat route
 * passes as `extraSystemText`, which claude.ts appends to the system prompt for
 * BOTH plan and act spawns (buildSystemPrompt is mode-agnostic about `extra`).
 *
 * Two guarantees:
 *   1. a stored personality yields its tone block (so the pick actually reaches
 *      the model the customer builds his website with), and
 *   2. the ABSENCE case (no profile — an existing install like the owner's) yields
 *      undefined, leaving the prompt byte-identical to today's default.
 */

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-chatsys-"));
  const data = path.join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
  process.env.VIDI_DATA_DIR = data;
  return data;
}

test.afterEach(() => {
  delete process.env.VIDI_DATA_DIR;
});

test("no profile → undefined (prompt unchanged for an existing install)", async () => {
  freshDataDir();
  const { chatExtraSystemText } = await import("../lib/chat-system-text.ts");
  assert.equal(chatExtraSystemText(), undefined);
});

test("a stored personality → its tone block reaches the chat prompt", async () => {
  const data = freshDataDir();
  // Write the profile the onboarding flow would persist.
  fs.writeFileSync(
    path.join(data, "profile.json"),
    JSON.stringify({ name: "Sam", personality: "direct", createdAt: Date.now() })
  );
  const { chatExtraSystemText } = await import("../lib/chat-system-text.ts");
  const { personaToneBlock, readProfile } = await import("../lib/onboarding.ts");

  const block = chatExtraSystemText();
  assert.equal(typeof block, "string");
  assert.ok((block as string).toLowerCase().includes("direct"));
  // It is exactly personaToneBlock of the stored profile — same wiring the
  // voice path uses, so the two never drift.
  assert.equal(block, personaToneBlock(readProfile()));
});

test("a bad/unknown personality → undefined (fail-open, no throw)", async () => {
  const data = freshDataDir();
  fs.writeFileSync(
    path.join(data, "profile.json"),
    JSON.stringify({ name: "Sam", personality: "nonsense", createdAt: Date.now() })
  );
  const { chatExtraSystemText } = await import("../lib/chat-system-text.ts");
  assert.equal(chatExtraSystemText(), undefined);
});
