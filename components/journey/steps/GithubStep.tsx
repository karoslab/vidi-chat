"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WorkingGlow from "@/components/WorkingGlow";

/**
 * Journey Stage 4 — "Your GitHub" (device-code onboarding).
 *
 * Three screens, in customer words (no "repo", "push", "token" — see the copy
 * rule): (1) get a free GitHub account, (2) the one-time code screen, (3) "your
 * memory is now backed up". No secret ever reaches this component — the browser
 * only sees the short display code and the connected flag; gh holds the
 * credential in the system keychain.
 *
 * Rendered by the journey registry (components/journey/StepScreen.tsx,
 * RICH_ACTIONS["github-connect"]) as the Stage-4 rich step screen, dropped into
 * that step's <StepFrame> `action` slot. Kept self-contained (its own
 * onDone/onSkip props, no StepFrame import) so the component stays testable in
 * isolation.
 */

type Screen = "account" | "device" | "success";

interface StartResponse {
  connected?: boolean;
  login?: string | null;
  userCode?: string;
  verificationUri?: string;
  error?: string;
  kind?: string;
}

const SIGNUP_URL = "https://github.com/signup";

export default function GithubStep({
  onDone,
  onBack,
  onSkip,
}: {
  onDone?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("account");
  const [code, setCode] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string>("https://github.com/login/device");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Ask the server for a fresh one-time code. "Open the page again" calls this
  // too, which mints a brand-new code (the old one is abandoned server-side).
  const startConnect = useCallback(async () => {
    setStarting(true);
    setError(null);
    setCode(null);
    try {
      const r = await fetch("/api/github/start-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j: StartResponse = await r.json();
      if (!r.ok) {
        setError(j.error || "Couldn't start the connection. Please try again.");
        return;
      }
      if (j.connected) {
        setLogin(j.login ?? null);
        setScreen("success");
        return;
      }
      setCode(j.userCode ?? null);
      if (j.verificationUri) setVerifyUrl(j.verificationUri);
      beginPolling();
    } catch {
      setError("Couldn't start the connection. Check your internet and try again.");
    } finally {
      setStarting(false);
    }
  }, []);

  // Poll the connected flag until the customer finishes on github.com.
  const beginPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/github/status");
        const j = await r.json();
        if (j.connected) {
          stopPolling();
          setLogin(j.login ?? null);
          setScreen("success");
        }
      } catch {
        /* transient — keep polling */
      }
    }, 4000);
  }, [stopPolling]);

  const goToDevice = useCallback(() => {
    setScreen("device");
    startConnect();
  }, [startConnect]);

  const openPage = useCallback(() => {
    // The customer's own browser opens the page — we never open it for them from
    // the server. A popup-blocked window just means they can type the address in.
    window.open(verifyUrl, "_blank", "noopener,noreferrer");
  }, [verifyUrl]);

  const runBackup = useCallback(async () => {
    setBackingUp(true);
    setBackupMsg(null);
    try {
      const r = await fetch("/api/github/backup-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await r.json();
      if (!r.ok) {
        setBackupMsg(j.error || "The backup didn't finish. Please try again.");
        return;
      }
      setBackupMsg(j.message || "Your memory is now backed up.");
    } catch {
      setBackupMsg("Couldn't reach GitHub for the backup. Try again in a moment.");
    } finally {
      setBackingUp(false);
    }
  }, []);

  /* ---------------------------------------------------------------- screens */

  if (screen === "account") {
    return (
      <div className="onb-step">
        <h2>Your GitHub</h2>
        <p>
          GitHub gives Vidi a private, safe place to keep a backup of everything
          you and Vidi remember. It's free, and only you can see it.
        </p>
        <ul className="onb-caps">
          <li>Already have a GitHub account? You can connect it on the next screen.</li>
          <li>
            New to GitHub? Make a free account first, then come back here.
            <ul>
              <li>Pick a username you'll recognise later, your first name and a number is fine.</li>
              <li>Use an email you can open right now: GitHub sends a code you have to type in to finish.</li>
            </ul>
          </li>
        </ul>
        <div className="onb-actions">
          {onBack && (
            <button className="onb-btn" onClick={onBack}>
              Back
            </button>
          )}
          <a
            className="onb-btn"
            href={SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create a free account
          </a>
          <button className="onb-btn onb-btn-primary" onClick={goToDevice}>
            I have an account, connect it
          </button>
        </div>
        {onSkip && (
          <button className="onb-btn onb-btn-skip vcstep-skip" onClick={onSkip}>
            Skip, I don't need backups
          </button>
        )}
      </div>
    );
  }

  if (screen === "device") {
    return (
      <div className="onb-step">
        <h2>Connect your GitHub</h2>
        <p>
          Open the GitHub page, then type in the code below. When you approve it
          on GitHub, this screen will move on by itself.
        </p>

        {starting && !code && <WorkingGlow lines={["Getting your code…"]} />}

        {code && (
          <div style={{ textAlign: "center", margin: "18px 0" }}>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>
              Your one-time code
            </div>
            <div
              aria-label={`Your one-time code is ${code.split("").join(" ")}`}
              style={{
                fontSize: 44,
                fontWeight: 700,
                letterSpacing: "0.18em",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "var(--text)",
                userSelect: "all",
              }}
            >
              {code}
            </div>
          </div>
        )}

        {error && <div className="onb-error">{error}</div>}

        <div className="onb-actions">
          {onBack && (
            <button className="onb-btn" onClick={() => { stopPolling(); setScreen("account"); }}>
              Back
            </button>
          )}
          <button className="onb-btn" onClick={startConnect} disabled={starting}>
            Open the page again
          </button>
          <button className="onb-btn onb-btn-primary" onClick={openPage} disabled={!code}>
            Open the GitHub page
          </button>
        </div>

        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">If something looks off</div>
            <ul className="onb-notice-points">
              <li>The page didn't open? Type this address into your browser: {verifyUrl}</li>
              <li>It says you're on the wrong account? Sign out on GitHub, then use "Open the page again".</li>
              <li>The code stopped working? Tap "Open the page again" for a fresh one.</li>
              <li>GitHub asks for a security code from your phone? That's normal. Enter it to continue.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // success
  return (
    <div className="onb-step">
      <h2>You're connected</h2>
      <p>
        {login ? `Connected as ${login}. ` : ""}
        Your memory now has a private, safe backup that only you can see. Vidi
        will keep it up to date from here.
      </p>

      {backupMsg && <div className="onb-backend-note">{backupMsg}</div>}

      <div className="onb-actions">
        <button className="onb-btn" onClick={runBackup} disabled={backingUp}>
          {backingUp ? "Backing up…" : "Back up my memory now"}
        </button>
        <button className="onb-btn onb-btn-primary" onClick={() => onDone?.()}>
          Done
        </button>
      </div>
    </div>
  );
}
