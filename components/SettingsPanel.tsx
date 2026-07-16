"use client";

import { useEffect, useRef, useState } from "react";
import VoiceSettings, { type VoiceSettingsHandle } from "./VoiceSettings";
import UpdatePanel from "./UpdatePanel";
import UsagePanel from "./UsagePanel";
import { usePersonaName, USER_CONFIG_CHANGED_EVENT } from "./usePersonaName";

/**
 * Settings panel (T1.3, tabbed 2026-07-12). The first design stacked every
 * section — names, voice, checklist, feedback, weekly summary, recent errors,
 * intro buttons — into one scrolling card with two competing Save buttons.
 * Customer feedback: crunched and confusing. Now four tabs, ONE Save:
 *
 *   General : what Vidi calls you, what you call Vidi, memory folder
 *   Voice   : system vs premium tier, voice code, consent, sample player
 *   Setup   : the finish-setting-up checklist + intro replay/chat
 *   Privacy : feedback compose, weekly summary consent, recent errors
 *
 * The single footer Save persists BOTH the general fields and the voice tab
 * (through VoiceSettings' imperative handle), so there is exactly one way to
 * save. Writes go through the same-origin-guarded /api/user-config and
 * /api/voice-config routes; raw errors stay in the server log, the panel only
 * ever shows a plain-language message.
 */

interface FieldSource {
  value: string;
  envLocked: boolean;
}
type Fields = Record<string, FieldSource>;

interface DeferredMeta {
  label: string;
  blurb: string;
}

// Plain-language labels + one-line help for each editable field.
const FIELD_META: Array<{ key: string; label: string; help: string; placeholder: string }> = [
  {
    key: "displayName",
    label: "What should I call you?",
    help: "The name I use in greetings and when I talk to you.",
    placeholder: "Your name",
  },
  {
    key: "assistantName",
    label: "What would you like to call me?",
    help: "The name I answer to. Leave it as Vidi, or give me your own name.",
    placeholder: "Vidi",
  },
  {
    key: "brainDirName",
    label: "Your memory folder",
    help: "The folder that holds everything I remember for you.",
    placeholder: "Brain",
  },
];

interface RecentError {
  ts: number;
  category: string;
  message: string;
}

type TabId = "general" | "voice" | "setup" | "privacy" | "usage" | "updates";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "voice", label: "Voice" },
  { id: "setup", label: "Setup" },
  { id: "privacy", label: "Privacy" },
  { id: "usage", label: "Usage" },
  { id: "updates", label: "Updates" },
];

export default function SettingsPanel({
  onClose,
  onReplayIntro,
  onIntroChat,
  onCompleteStep,
  onFeedback,
  initialTab,
}: {
  onClose: () => void;
  /** Re-watch the first-run intro (T1.5). Replay never rewrites the profile. */
  onReplayIntro: () => void;
  /** Re-open the conversational intro chat (T2.2). */
  onIntroChat: () => void;
  /** FW3 — deep-link a deferred checklist item into onboarding AT its own step
   *  in a completing (non-replay) scoped mode, so finishing it persists for real
   *  and clears the item. `intro` still routes to onIntroChat. */
  onCompleteStep: (step: string) => void;
  /** Open the "Tell the owner what you think" compose screen. */
  onFeedback: () => void;
  /** Which tab to open on (deep links like ?settings=voice). */
  initialTab?: TabId;
}) {
  const [tab, setTab] = useState<TabId>(initialTab ?? "general");
  const personaName = usePersonaName();
  const [fields, setFields] = useState<Fields | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const voiceRef = useRef<VoiceSettingsHandle | null>(null);
  // Deferred-onboarding checklist (T2.4) — skipped steps to "finish setting up".
  const [deferredSteps, setDeferredSteps] = useState<string[]>([]);
  const [deferredMeta, setDeferredMeta] = useState<Record<string, DeferredMeta>>({});
  // Recent errors affordance (DIAGNOSTICS + FEEDBACK loop) — plain, scrubbed.
  const [recentErrors, setRecentErrors] = useState<RecentError[]>([]);
  // Weekly health summary consent (default OFF, fail-closed).
  const [weeklySummary, setWeeklySummary] = useState(false);
  const [weeklySaving, setWeeklySaving] = useState(false);
  // Browser Rails consent (Phase 1, default OFF, fail-closed). A new trust
  // surface: letting Vidi drive a browser gets its own explicit switch.
  const [browserRails, setBrowserRails] = useState(false);
  const [browserSaving, setBrowserSaving] = useState(false);

  useEffect(() => {
    fetch("/api/diag/recent")
      .then((r) => r.json())
      .then((j) => setRecentErrors(Array.isArray(j.entries) ? j.entries : []))
      .catch(() => {
        /* the recent-errors list is a gentle extra — its failure never blocks */
      });
    fetch("/api/feedback/consent")
      .then((r) => r.json())
      .then((j) => setWeeklySummary(j.weeklySummary === true))
      .catch(() => {
        /* fail-closed: leave the toggle off if we can't read consent */
      });
    fetch("/api/browser-rails")
      .then((r) => r.json())
      .then((j) => setBrowserRails(j.on === true))
      .catch(() => {
        /* fail-closed: leave Browser Rails off if we can't read consent */
      });
  }, []);

  const toggleBrowserRails = async (enabled: boolean) => {
    setBrowserSaving(true);
    // Optimistic; revert on failure so the toggle never lies about consent.
    setBrowserRails(enabled);
    try {
      const r = await fetch("/api/browser-rails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: enabled }),
      });
      const j = await r.json().catch(() => ({}));
      setBrowserRails(j.on === true);
    } catch {
      setBrowserRails(!enabled);
    } finally {
      setBrowserSaving(false);
    }
  };

  const toggleWeeklySummary = async (enabled: boolean) => {
    setWeeklySaving(true);
    // Optimistic; revert on failure so the toggle never lies about consent.
    setWeeklySummary(enabled);
    try {
      const r = await fetch("/api/feedback/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeklySummary: enabled }),
      });
      const j = await r.json().catch(() => ({}));
      setWeeklySummary(j.weeklySummary === true);
    } catch {
      setWeeklySummary(!enabled);
    } finally {
      setWeeklySaving(false);
    }
  };

  useEffect(() => {
    fetch("/api/user-config")
      .then((r) => r.json())
      .then((j) => {
        const f: Fields = j.fields || {};
        setFields(f);
        const initial: Record<string, string> = {};
        for (const meta of FIELD_META) initial[meta.key] = f[meta.key]?.value ?? "";
        setDrafts(initial);
      })
      .catch(() => setErr("Couldn't load your settings just now. Try reopening this."));

    fetch("/api/onboarding/deferred")
      .then((r) => r.json())
      .then((j) => {
        setDeferredSteps(Array.isArray(j.steps) ? j.steps : []);
        setDeferredMeta(j.meta || {});
      })
      .catch(() => {
        /* the checklist is a gentle extra — its failure never blocks settings */
      });
  }, []);

  /** THE save — general fields and the voice tab together, one button. */
  const save = async () => {
    setSaving(true);
    setErr(null);
    setSavedNote(false);
    try {
      // Only send fields that aren't env-locked (the server skips those anyway).
      const body: Record<string, string> = {};
      for (const meta of FIELD_META) {
        if (!fields?.[meta.key]?.envLocked) body[meta.key] = drafts[meta.key] ?? "";
      }
      const r = await fetch("/api/user-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "save failed");
      if (j.fields) setFields(j.fields);
      // The persona name may have changed — let the header/composer know now.
      window.dispatchEvent(new Event(USER_CONFIG_CHANGED_EVENT));
      // Voice settings ride the same Save (only when something there changed).
      if (voiceRef.current?.isDirty()) {
        try {
          await voiceRef.current.save();
        } catch (voiceErr: any) {
          setTab("voice"); // show the field-level error where it happened
          throw voiceErr;
        }
      }
      setSavedNote(true);
    } catch (e: any) {
      // Plain-language only; real detail is in the server log / network tab.
      setErr(e?.message?.startsWith("Couldn't") ? e.message : "Couldn't save just now. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="onb-backdrop" onClick={onClose}>
      <div className="onb-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="settings-close" title="Close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "settings-tab active" : "settings-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === "setup" && deferredSteps.length > 0 && (
                <span className="settings-tab-badge">{deferredSteps.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "general" && (
            <>
              {!fields && !err && <p>Loading…</p>}
              {fields &&
                FIELD_META.map((meta) => {
                  const source = fields[meta.key];
                  const envLocked = !!source?.envLocked;
                  return (
                    <div className="settings-field" key={meta.key}>
                      <label className="settings-label">
                        {meta.label}
                        {envLocked && <span className="settings-env-badge">set by environment</span>}
                      </label>
                      <input
                        className="onb-input settings-input"
                        value={drafts[meta.key] ?? ""}
                        placeholder={meta.placeholder}
                        disabled={envLocked || saving}
                        onChange={(e) => setDrafts((d) => ({ ...d, [meta.key]: e.target.value }))}
                      />
                      <div className="settings-help">{meta.help}</div>
                    </div>
                  );
                })}
            </>
          )}

          {/* Voice stays mounted across tab switches so unsaved edits survive
              a peek at another tab; the single footer Save reads its handle. */}
          <div style={{ display: tab === "voice" ? undefined : "none" }}>
            <VoiceSettings ref={voiceRef} />
          </div>

          {tab === "setup" && (
            <>
              {deferredSteps.length > 0 ? (
                <div className="settings-field settings-checklist">
                  <div className="settings-checklist-head">Finish setting up</div>
                  <div className="settings-checklist-note">
                    A few things you skipped. Pick up any of them whenever you like.
                  </div>
                  {deferredSteps.map((step) => {
                    const meta = deferredMeta[step];
                    return (
                      <div className="settings-checklist-item" key={step}>
                        <div className="settings-checklist-body">
                          <span className="settings-checklist-label">
                            {meta?.label ?? step}
                          </span>
                          {meta?.blurb && (
                            <span className="settings-checklist-blurb">{meta.blurb}</span>
                          )}
                        </div>
                        <button
                          className="settings-checklist-jump"
                          onClick={() => (step === "intro" ? onIntroChat() : onCompleteStep(step))}
                        >
                          {step === "intro" ? "Chat" : "Finish"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="settings-field">
                  <div className="settings-help">
                    Nothing left to set up. Everything from the walkthrough is done.
                  </div>
                </div>
              )}

              <div className="settings-field">
                <button className="settings-open-btn" onClick={onReplayIntro}>
                  Show me the intro again
                </button>
                <div className="settings-help">Re-watch the first-run walkthrough. Nothing is changed.</div>
              </div>

              <div className="settings-field">
                <button className="settings-open-btn" onClick={onIntroChat}>
                  Chat with {personaName}{" "}to get set up
                </button>
                <div className="settings-help">
                  Takes you to the chat. Just say what you want set up.
                </div>
              </div>
            </>
          )}

          {tab === "usage" && <UsagePanel />}

          {tab === "updates" && <UpdatePanel />}

          {tab === "privacy" && (
            <>
              <div className="settings-field">
                <button className="settings-open-btn" onClick={onFeedback}>
                  Tell the owner what you think
                </button>
                <div className="settings-help">
                  Send a note, and optionally a short technical report. You see exactly
                  what goes before it sends. Nothing is sent on its own.
                </div>
              </div>

              <div className="settings-field">
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={weeklySummary}
                    disabled={weeklySaving}
                    onChange={(e) => toggleWeeklySummary(e.target.checked)}
                  />
                  <span>
                    Send the owner a weekly summary. Once a week Vidi sends them counts of
                    how things ran and any errors, so they can keep this working well for
                    you. Never your conversations or files, only numbers. Off unless you
                    turn it on.
                  </span>
                </label>
              </div>

              <div className="settings-field">
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={browserRails}
                    disabled={browserSaving}
                    onChange={(e) => toggleBrowserRails(e.target.checked)}
                  />
                  <span>
                    Let Vidi use a browser. When this is on, Vidi can open web pages,
                    read them, and click through them to do a task for you. She always
                    starts a brand new, empty browser with nothing logged in, and she
                    can only visit the sites you approve for that task. Your passwords
                    and logins stay out of reach: there is no saved account for her to
                    open, she never downloads files, and she never signs in as you. The
                    first time you turn this on, Vidi downloads a small browser
                    component (about 150 MB). Off unless you turn it on.
                  </span>
                </label>
              </div>

              <div className="settings-field settings-recent-errors">
                <div className="settings-checklist-head">Recent errors</div>
                {recentErrors.length === 0 ? (
                  <div className="settings-help">Nothing has gone wrong recently.</div>
                ) : (
                  <ul className="settings-recent-list">
                    {recentErrors.map((entry, i) => (
                      <li key={i} className="settings-recent-item">
                        <span className="settings-recent-when">
                          {new Date(entry.ts).toLocaleString()}
                        </span>
                        <span className="settings-recent-msg">{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        {err && <div className="onb-error">{err}</div>}
        {savedNote && !err && <div className="settings-saved">Saved.</div>}

        <div className="onb-actions">
          <button className="onb-btn" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button className="onb-btn onb-btn-primary" onClick={save} disabled={saving || !fields}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
