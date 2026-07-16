import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the data dir before importing (writeEditableConfig / getAssistantName
// round-trip through dataPath()). Empty dir → defaults.
process.env.VIDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-assistant-name-"));

const {
  getAssistantName,
  writeEditableConfig,
  _resetUserConfigCache,
  ConfigValidationError,
  EDITABLE_CONFIG_FIELDS,
} = await import("../lib/user-config.ts");
const { assistantPersonaNameBlock, chatExtraSystemText } = await import(
  "../lib/chat-system-text.ts"
);
const { ASSISTANT_NAME } = await import("../lib/assistant-identity.ts");

function clearConfig() {
  delete process.env.VIDI_ASSISTANT_NAME;
  try {
    fs.rmSync(path.join(process.env.VIDI_DATA_DIR!, "user-config.json"));
  } catch {
    /* nothing to clear */
  }
  _resetUserConfigCache();
}

test("assistantName defaults to the brand name (Vidi) with no override", () => {
  clearConfig();
  assert.equal(getAssistantName(), ASSISTANT_NAME);
  assert.equal(getAssistantName(), "Vidi");
});

test("assistantName is one of the editable settings fields", () => {
  assert.ok((EDITABLE_CONFIG_FIELDS as readonly string[]).includes("assistantName"));
});

test("writeEditableConfig sets a custom persona name and it reads back", () => {
  clearConfig();
  writeEditableConfig({ assistantName: "Anna" });
  assert.equal(getAssistantName(), "Anna");
});

test("VIDI_ASSISTANT_NAME env var overrides the file value", () => {
  clearConfig();
  writeEditableConfig({ assistantName: "Anna" });
  process.env.VIDI_ASSISTANT_NAME = "Ravi";
  _resetUserConfigCache();
  try {
    assert.equal(getAssistantName(), "Ravi");
  } finally {
    delete process.env.VIDI_ASSISTANT_NAME;
    _resetUserConfigCache();
  }
});

test("an over-long assistant name is rejected before disk", () => {
  clearConfig();
  assert.throws(() => writeEditableConfig({ assistantName: "x".repeat(61) }), ConfigValidationError);
});

test("control characters in the assistant name are stripped (prompt-injection guard)", () => {
  clearConfig();
  writeEditableConfig({ assistantName: "An\nna\tHelper" });
  const stored = getAssistantName();
  assert.ok(!/[\n\t]/.test(stored), "stored name must not carry newlines/tabs");
  assert.equal(stored, "An na Helper");
});

/* -------------------------------------------------------------------------- */
/* Persona-block wiring                                                         */
/* -------------------------------------------------------------------------- */

test("assistantPersonaNameBlock is null on a default install (byte-identical prompt)", () => {
  clearConfig();
  assert.equal(assistantPersonaNameBlock(), null);
  // chatExtraSystemText has no profile + no custom name → undefined.
  assert.equal(chatExtraSystemText(), undefined);
});

test("a custom name produces a persona-name block naming it", () => {
  clearConfig();
  writeEditableConfig({ assistantName: "Anna" });
  const block = assistantPersonaNameBlock();
  assert.ok(block, "expected a persona-name block");
  assert.match(block!, /\bAnna\b/);
  // It flows into the chat system text too.
  const extra = chatExtraSystemText();
  assert.ok(extra && extra.includes("Anna"), "chatExtraSystemText must carry the persona name");
});

test("persona-name block has no em/en dashes (published copy rule)", () => {
  clearConfig();
  writeEditableConfig({ assistantName: "Anna" });
  assert.ok(!/[—–]/.test(assistantPersonaNameBlock()!));
});
