import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/**
 * Settings/voice UI wiring (2026-07-12 redesign). Client components can't run
 * under plain `node --test`, so — following the tts-route-wiring convention —
 * we pin the load-bearing SOURCE contracts of the customer-reported fixes:
 *
 *   1. ONE Save. The old panel had its own Save plus VoiceSettings' "Save
 *      voice settings" — the first customer found two Saves confusing, and
 *      the voice one silently didn't reach the live chat.
 *   2. Saving the voice config must notify the open chat (the token-saved-
 *      but-still-system-voice bug: Chat read /api/voice-config once at mount
 *      and never again until a full page reload).
 *   3. The persona name must come from config everywhere (the header/composer
 *      kept saying "Vidi" after the install was named).
 */

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const voiceSettings = read("components/VoiceSettings.tsx");
const settingsPanel = read("components/SettingsPanel.tsx");
const chat = read("components/Chat.tsx");
const appNav = read("components/AppNav.tsx");

test("VoiceSettings no longer has its own save button (single-Save model)", () => {
  assert.doesNotMatch(voiceSettings, /Save voice settings/);
  // It exposes an imperative handle instead, driven by the panel's one Save.
  assert.match(voiceSettings, /useImperativeHandle/);
  assert.match(voiceSettings, /isDirty/);
});

test("VoiceSettings broadcasts the config change so the live chat re-reads it", () => {
  assert.match(voiceSettings, /VOICE_CONFIG_CHANGED_EVENT\s*=\s*"vidi:voice-config-changed"/);
  assert.match(voiceSettings, /dispatchEvent\(new Event\(VOICE_CONFIG_CHANGED_EVENT\)\)/);
});

test("Chat listens for voice-config changes instead of reading once at mount", () => {
  assert.match(chat, /addEventListener\("vidi:voice-config-changed"/);
  assert.match(chat, /removeEventListener\("vidi:voice-config-changed"/);
});

test("SettingsPanel is tabbed and drives the voice save through the handle", () => {
  assert.match(settingsPanel, /settings-tabs/);
  assert.match(settingsPanel, /voiceRef\.current\?\.isDirty\(\)/);
  assert.match(settingsPanel, /voiceRef\.current\.save\(\)/);
  // Exactly one primary Save button in the panel source.
  const primaries = settingsPanel.match(/onb-btn-primary/g) ?? [];
  assert.equal(primaries.length, 1);
});

test("SettingsPanel announces persona-name changes for live header/composer updates", () => {
  assert.match(settingsPanel, /USER_CONFIG_CHANGED_EVENT/);
  assert.match(settingsPanel, /dispatchEvent\(new Event\(USER_CONFIG_CHANGED_EVENT\)\)/);
});

test("Chat and AppNav both take the persona name from config, not the brand constant", () => {
  assert.match(chat, /usePersonaName\(\)/);
  assert.doesNotMatch(chat, /const assistantName = ASSISTANT_NAME/);
  assert.match(appNav, /usePersonaName/);
});
