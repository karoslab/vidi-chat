"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonaName } from "./usePersonaName";

/**
 * The "Updates" tab in Settings (T-updater). Shows the current version, checks
 * the release channel, and — when a newer version is offered — surfaces the
 * plain-language notes and ONE "Update now" button that drives the over-the-air
 * update with live phase progress. Vidi restarts itself when it finishes.
 *
 * Copy is plain language, no dashes. All the risky work happens server-side
 * (lib/updater.ts); this component only reflects status the server reports.
 */

interface CheckResult {
  available: boolean;
  current: { version: string; sha: string };
  latest?: { version: string; sha: string };
  notes?: string;
  devBuild?: boolean;
  error?: string;
}

interface Status {
  phase: string;
  pct?: number;
  logTail?: string;
  done: boolean;
  ok: boolean;
  error?: string;
  version?: string;
}

// Plain-language label for each phase the server reports.
const PHASE_LABEL: Record<string, string> = {
  checking: "Checking for the latest version",
  downloading: "Downloading the update",
  verifying: "Making sure it is safe",
  unpacking: "Unpacking the new version",
  installing: "Installing the pieces it needs",
  building: "Getting it ready",
  swapping: "Putting it in place",
  done: "Done",
  error: "Something went wrong",
};

function currentLabel(check: CheckResult | null): string {
  if (!check) return "…";
  if (check.devBuild) return "development build";
  return check.current?.version || "unknown";
}

export default function UpdatePanel() {
  const personaName = usePersonaName();
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/update/check");
      const j = (await r.json()) as CheckResult;
      setCheck(j);
    } catch {
      setCheck({
        available: false,
        current: { version: "", sha: "" },
        error: "Could not check for updates just now. Try again in a moment.",
      });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    runCheck();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runCheck]);

  const poll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/update/status");
        const j = (await r.json()) as Status;
        setStatus(j);
        if (j.done) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          // On success the server exits and launchd respawns on the new code;
          // keep the panel showing the restart line. On failure re-enable the
          // button so the person can try again.
          if (!j.ok) setApplying(false);
        }
      } catch {
        // A failing poll during the final restart is EXPECTED — the server is
        // going down and coming back on the new version. Leave the last status
        // (the reassuring restart line) on screen.
      }
    }, 1500);
  }, []);

  const apply = useCallback(async () => {
    setApplying(true);
    setStatus({ phase: "checking", done: false, ok: false });
    try {
      const r = await fetch("/api/update/apply", { method: "POST" });
      if (r.status === 409) {
        // Already running (e.g. started from the banner) — just watch it.
        poll();
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      poll();
    } catch {
      setApplying(false);
      setStatus({
        phase: "error",
        done: true,
        ok: false,
        error: "Could not start the update just now. Try again in a moment.",
      });
    }
  }, [poll]);

  const phase = status?.phase ?? "";
  const restarting = applying && status?.done === true && status?.ok === true;

  return (
    <div className="settings-field">
      <div className="settings-label">This version</div>
      <div className="settings-help" style={{ fontSize: "1rem", fontWeight: 600 }}>
        {currentLabel(check)}
      </div>

      {check?.devBuild && (
        <div className="settings-help">
          This is a development build, so over-the-air updates are turned off here.
        </div>
      )}

      {check?.error && <div className="onb-error">{check.error}</div>}

      {/* Up to date */}
      {check && !check.available && !check.devBuild && !check.error && (
        <div className="settings-help">You are on the latest version.</div>
      )}

      {/* An update is available and we are not already applying it */}
      {check?.available && !applying && (
        <div className="settings-field settings-checklist" style={{ marginTop: "0.75rem" }}>
          <div className="settings-checklist-head">
            A newer version is ready{check.latest?.version ? ` (${check.latest.version})` : ""}
          </div>
          {check.notes && <div className="settings-checklist-note">{check.notes}</div>}
          <button className="onb-btn onb-btn-primary" onClick={apply} style={{ marginTop: "0.75rem" }}>
            Update now
          </button>
          <div className="settings-help" style={{ marginTop: "0.5rem" }}>
            {personaName}{" "}will restart by itself when it finishes. This can take a few
            minutes on an older Mac.
          </div>
        </div>
      )}

      {/* Applying — live phase progress */}
      {applying && (
        <div className="settings-field settings-checklist" style={{ marginTop: "0.75rem" }}>
          <div className="settings-checklist-head">
            {restarting ? "All set" : "Updating"}
          </div>
          <div className="settings-checklist-note">
            {restarting
              ? `${personaName} will restart by itself in a moment. This page will come back on the new version.`
              : PHASE_LABEL[phase] ?? "Working"}
          </div>
          {status?.error && <div className="onb-error">{status.error}</div>}
        </div>
      )}

      {/* Manual re-check (hidden while an update is running) */}
      {!applying && (
        <div className="settings-field" style={{ marginTop: "0.75rem" }}>
          <button className="settings-open-btn" onClick={runCheck} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>
      )}
    </div>
  );
}
