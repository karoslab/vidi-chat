"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  PREMIUM_VOICE_CATALOG,
  pickBestSystemVoice,
  type PremiumVoiceCatalogEntry,
  type VoiceConfig,
  type VoiceTier,
} from "@/lib/voice-catalog";
import { voiceEgressConsentDisclosure } from "@/lib/security-notice";

/**
 * Voice-tier settings (2026-07-11, redesigned 2026-07-12). Lives in the Voice
 * tab of the Settings panel. Two tiers:
 *
 *   - System voice : the browser's own speechSynthesis voice. Zero config, zero
 *     egress, works on every install. The DEFAULT for a fresh install.
 *   - Premium voice : synthesized through Vidi's voice service. An owner has it
 *     already; a customer pastes a voice code and accepts the voice-egress
 *     consent first (the disclosure is shown right here before they turn it on).
 *
 * There is deliberately NO save button here — the panel's single Save drives
 * saving through the imperative handle, so the user never sees two Saves.
 * After a successful save this component broadcasts "vidi:voice-config-changed"
 * so the live chat re-reads the config immediately (the old design required a
 * full page reload before the new voice was used).
 */

export const VOICE_CONFIG_CHANGED_EVENT = "vidi:voice-config-changed";

export interface VoiceSettingsHandle {
  /** True when the user changed something that isn't saved yet. */
  isDirty: () => boolean;
  /** Persist the voice settings. Resolves on success, throws a plain-language Error. */
  save: () => Promise<void>;
}

interface VoiceState {
  config: VoiceConfig;
  owner: boolean;
  hasVoiceKey: boolean;
  hasConsent: boolean;
  catalog: readonly PremiumVoiceCatalogEntry[];
}

const SAMPLE_LINE = "Hi, this is the voice I'll use when I read my replies out loud.";

const VoiceSettings = forwardRef<VoiceSettingsHandle, object>(function VoiceSettings(
  _props,
  ref
) {
  const [state, setState] = useState<VoiceState | null>(null);
  const [localVoices, setLocalVoices] = useState<{ name: string; lang: string }[]>([]);
  const [tier, setTier] = useState<VoiceTier>("system");
  const [systemVoice, setSystemVoice] = useState<string>("");
  const [premiumVoiceId, setPremiumVoiceId] = useState<string>("");
  const [voiceCode, setVoiceCode] = useState<string>("");
  const [consent, setConsent] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [sampleState, setSampleState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const [sampleNote, setSampleNote] = useState<string | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/api/voice-config")
      .then((r) => r.json())
      .then((j: VoiceState) => {
        setState(j);
        setTier(j.config.tier);
        setSystemVoice(j.config.systemVoice ?? "");
        setPremiumVoiceId(j.config.premiumVoiceId ?? "");
        setConsent(j.hasConsent);
      })
      .catch(() => setErr("Couldn't load your voice settings just now. Try reopening this."));
  }, []);

  // The local speechSynthesis voices populate asynchronously in some browsers.
  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return;
    const load = () => {
      const voices = synth.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
      setLocalVoices(voices);
      // Default the picker to the best local voice if none is stored yet.
      setSystemVoice((current) => current || pickBestSystemVoice(voices) || "");
    };
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, []);

  const isDirty = () => {
    if (!state) return false;
    return (
      tier !== state.config.tier ||
      systemVoice !== (state.config.systemVoice ?? "") ||
      premiumVoiceId !== (state.config.premiumVoiceId ?? "") ||
      voiceCode.trim() !== "" ||
      consent !== state.hasConsent
    );
  };

  const save = async () => {
    setErr(null);
    const body: Record<string, unknown> = { tier, systemVoice, premiumVoiceId };
    if (voiceCode.trim()) body.voiceKey = voiceCode.trim();
    body.consent = consent;
    const r = await fetch("/api/voice-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg =
        typeof j.error === "string" && j.error
          ? j.error
          : "Couldn't save your voice settings just now. Try again in a moment.";
      setErr(msg);
      throw new Error(msg);
    }
    setState(j);
    setVoiceCode(""); // never keep the pasted code in the field
    // Tell the live chat right away — no reload needed before the new voice is used.
    window.dispatchEvent(new Event(VOICE_CONFIG_CHANGED_EVENT));
  };

  useImperativeHandle(ref, () => ({ isDirty, save }));

  /** Play one sample line through exactly the path chat replies will use.
   *  Saves first when dirty, so what you hear is what you saved. */
  const hearSample = async () => {
    setSampleNote(null);
    setSampleState("loading");
    try {
      if (isDirty()) await save();
      if (tier === "premium") {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: SAMPLE_LINE }),
        });
        if (!r.ok) {
          const localOnly = r.headers.get("X-Vidi-Local-Only") === "1";
          setSampleState("failed");
          setSampleNote(
            localOnly
              ? "Premium voice isn't on yet. Check that a voice code is saved and the consent box is ticked."
              : "The premium voice service didn't answer. Check the voice code, or try again in a moment."
          );
          return;
        }
        const blob = await r.blob();
        if (!sampleAudioRef.current) sampleAudioRef.current = new Audio();
        const el = sampleAudioRef.current;
        if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src);
        el.src = URL.createObjectURL(blob);
        el.onended = () => setSampleState("idle");
        await el.play();
        setSampleState("playing");
      } else {
        const synth = window.speechSynthesis;
        if (!synth) {
          setSampleState("failed");
          setSampleNote("This browser can't speak on its own.");
          return;
        }
        synth.cancel();
        const u = new SpeechSynthesisUtterance(SAMPLE_LINE);
        u.rate = 1.05;
        const voices = synth.getVoices();
        u.voice = voices.find((v) => v.name === systemVoice) || null;
        u.onend = () => setSampleState("idle");
        synth.speak(u);
        setSampleState("playing");
      }
    } catch {
      setSampleState("failed");
      if (!err) setSampleNote("Couldn't play the sample just now. Try again in a moment.");
    }
  };

  if (!state && !err) return <p className="settings-help">Loading voice settings…</p>;

  const owner = state?.owner ?? false;
  const englishVoices = localVoices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
  const voiceOptions = englishVoices.length > 0 ? englishVoices : localVoices;

  // One honest status line: what will actually happen when Vidi speaks, and —
  // when premium won't engage — exactly which ingredient is missing.
  let statusTone: "on" | "off" | "warn" = "off";
  let statusText = "Using your Mac's own voice. Nothing leaves this computer.";
  if (tier === "premium") {
    if (owner) {
      statusTone = "on";
      statusText = "Premium voice is on. This install includes it.";
    } else if (!state?.hasVoiceKey && !voiceCode.trim()) {
      statusTone = "warn";
      statusText = "Premium voice needs a voice code before it can turn on.";
    } else if (!consent) {
      statusTone = "warn";
      statusText = "Premium voice needs the consent box ticked before it can turn on.";
    } else {
      statusTone = "on";
      statusText = "Premium voice is on. Replies are spoken in the voice you picked.";
    }
  }

  return (
    <div className="settings-field settings-voice">
      <div className="settings-help">How I speak my replies out loud.</div>

      <div className={`settings-voice-status settings-voice-status-${statusTone}`}>
        <span className="settings-voice-status-dot" aria-hidden />
        {statusText}
      </div>

      <div className="settings-voice-tier">
        <label className={tier === "system" ? "settings-voice-tier-card selected" : "settings-voice-tier-card"}>
          <input
            type="radio"
            name="voiceTier"
            checked={tier === "system"}
            onChange={() => setTier("system")}
          />
          <span className="settings-voice-tier-body">
            <span className="settings-voice-tier-label">System voice</span>
            <span className="settings-voice-tier-blurb">
              Your Mac's own voice. Nothing leaves this computer.
            </span>
          </span>
        </label>
        <label className={tier === "premium" ? "settings-voice-tier-card selected" : "settings-voice-tier-card"}>
          <input
            type="radio"
            name="voiceTier"
            checked={tier === "premium"}
            onChange={() => setTier("premium")}
          />
          <span className="settings-voice-tier-body">
            <span className="settings-voice-tier-label">Premium voice</span>
            <span className="settings-voice-tier-blurb">
              A more natural voice from Vidi's voice service.
            </span>
          </span>
        </label>
      </div>

      {tier === "system" && (
        <div className="settings-voice-picker">
          <label className="settings-label">Which voice</label>
          <select
            className="onb-input settings-input"
            value={systemVoice}
            onChange={(e) => setSystemVoice(e.target.value)}
          >
            {voiceOptions.length === 0 && <option value="">Default voice</option>}
            {voiceOptions.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
                {v.lang ? ` (${v.lang})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {tier === "premium" && (
        <div className="settings-voice-premium">
          <label className="settings-label">Which premium voice</label>
          <select
            className="onb-input settings-input"
            value={premiumVoiceId}
            onChange={(e) => setPremiumVoiceId(e.target.value)}
          >
            <option value="">Default voice</option>
            {PREMIUM_VOICE_CATALOG.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>

          {!owner && (
            <div className="settings-voice-code">
              <label className="settings-label">
                Voice code {state?.hasVoiceKey ? <span className="settings-voice-code-saved">saved ✓</span> : ""}
              </label>
              <input
                className="onb-input settings-input"
                type="password"
                autoComplete="off"
                value={voiceCode}
                placeholder={state?.hasVoiceKey ? "A code is saved. Paste a new one to replace it." : "vidi_live_..."}
                onChange={(e) => setVoiceCode(e.target.value)}
              />
              <div className="settings-help">Paste the code you were given to turn on premium voice.</div>
            </div>
          )}

          <label className="settings-voice-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            {voiceEgressConsentDisclosure(owner)}
          </label>
        </div>
      )}

      <div className="settings-voice-sample">
        <button
          className="onb-btn"
          onClick={hearSample}
          disabled={sampleState === "loading"}
        >
          {sampleState === "loading" ? "Getting the voice…" : "Hear a sample"}
        </button>
        <span className="settings-help">
          {isDirty() ? "Saves your choices, then plays one line." : "Plays one line in this voice."}
        </span>
      </div>
      {sampleNote && <div className="onb-error">{sampleNote}</div>}

      {err && <div className="onb-error">{err}</div>}
    </div>
  );
});

export default VoiceSettings;
