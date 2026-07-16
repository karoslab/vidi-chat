"use client";

import { useEffect, useState } from "react";

/**
 * Feedback compose screen (DIAGNOSTICS + FEEDBACK loop).
 *
 * Free text plus an optional "include a technical report" toggle. When the
 * toggle is on, the EXACT scrubbed bundle that would be sent is rendered right
 * here for the user to read BEFORE they send. Nothing leaves the machine until
 * the user hits Send (zero silent egress). If no connection code is stored, the
 * screen explains plainly that reports need it and points to Settings.
 *
 * Copy is plain and dash-free per house style.
 */
export default function FeedbackCompose({
  onClose,
  prefill = "",
  onOpenSettings,
}: {
  onClose: () => void;
  /** Prefilled text (from the chat "send this to the owner" chip). */
  prefill?: string;
  /** Open Settings (for the no-key guidance link). */
  onOpenSettings?: () => void;
}) {
  const [text, setText] = useState(prefill);
  const [includeReport, setIncludeReport] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<
    null | { kind: "sent" } | { kind: "no-key" } | { kind: "error"; message: string }
  >(null);

  useEffect(() => {
    fetch("/api/feedback")
      .then((r) => r.json())
      .then((j) => {
        setReport(typeof j.report === "string" ? j.report : "");
        setHasKey(j.hasKey === true);
      })
      .catch(() => {
        setReport("");
        setHasKey(false);
      });
  }, []);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    setStatus(null);
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), includeReport }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.sent === true) {
        setStatus({ kind: "sent" });
      } else if (j.reason === "no-key") {
        setStatus({ kind: "no-key" });
      } else {
        setStatus({ kind: "error", message: "Couldn't send that just now. Try again in a moment." });
      }
    } catch {
      setStatus({ kind: "error", message: "Couldn't send that just now. Try again in a moment." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="onb-backdrop" onClick={onClose}>
      <div className="onb-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Tell the owner what you think</h2>
          <button className="settings-close" title="Close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {status?.kind === "sent" ? (
          <div className="settings-field">
            <div className="settings-saved">Sent. Thank you, this really helps.</div>
            <div className="onb-actions">
              <button className="onb-btn onb-btn-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="settings-field">
              <label className="settings-label" htmlFor="feedback-text">
                What's on your mind?
              </label>
              <textarea
                id="feedback-text"
                className="onb-input settings-input"
                rows={4}
                placeholder="What's working, what's confusing, or anything you'd like changed."
                value={text}
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={includeReport}
                  disabled={sending}
                  onChange={(e) => setIncludeReport(e.target.checked)}
                />
                <span>
                  Include a technical report (recent error counts and app details,
                  never your conversations or files)
                </span>
              </label>
              {includeReport && (
                <div className="feedback-report-preview">
                  <div className="settings-help">
                    This is exactly what will be sent with your note:
                  </div>
                  <pre className="feedback-report-pre">{report ?? "Loading…"}</pre>
                </div>
              )}
            </div>

            {hasKey === false && (
              <div className="onb-error">
                Sending needs your connection code, which isn't set up on this
                computer yet. You can add it in{" "}
                {onOpenSettings ? (
                  <button className="feedback-inline-link" onClick={onOpenSettings}>
                    Settings
                  </button>
                ) : (
                  "Settings"
                )}
                .
              </div>
            )}
            {status?.kind === "no-key" && (
              <div className="onb-error">
                Reports need your connection code. Add it in Settings, then try again.
              </div>
            )}
            {status?.kind === "error" && <div className="onb-error">{status.message}</div>}

            <div className="onb-actions">
              <button className="onb-btn" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                className="onb-btn onb-btn-primary"
                onClick={send}
                disabled={sending || !text.trim() || hasKey === false}
              >
                {sending ? "Sending…" : "Send to the owner"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
