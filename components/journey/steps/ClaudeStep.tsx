"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonaName } from "@/components/usePersonaName";
import WorkingGlow from "@/components/WorkingGlow";

/**
 * Journey Stage 2 — "Connect Claude" (Phase A of the Helper demotion).
 *
 * The in-app port of the native Vidi Helper's "Connect AI provider" flow, so a
 * non-technical customer connects Claude without ever opening the Helper menu or
 * Terminal. Modeled on GithubStep: a rich step screen with its own actions,
 * driven by the server tri-state (missing / signed-out / signed-in):
 *
 *   missing     → "Install the AI brain" with live progress (poll the install
 *                 route, friendly phase text + a collapsible log tail).
 *   signed-out  → "Open sign-in" (your browser opens; sign in with YOUR OWN
 *                 account) then a Re-check.
 *   signed-in   → green; move on.
 *
 * No secret ever reaches this component — the browser only sees the tri-state
 * and the (own-output) install log tail. Copy rule: plain language, no dashes.
 * Turbopack JSX gotcha: a trailing space after {expr} is eaten — write
 * {name}{" "}text.
 */

type Connection = "missing" | "signed-out" | "signed-in" | "unknown";

type LoginState =
  | "idle"
  | "starting"
  | "url-ready"
  | "waiting"
  | "done"
  | "failed";

interface LoginStatus {
  state: LoginState;
  url?: string;
  method?: "pty" | "blind";
}

interface InstallStatus {
  phase: string;
  done: boolean;
  ok: boolean;
  logTail: string;
  connection: Connection;
  /** Phase B — PTY sign-in state. Optional so a stale Phase A server is safe. */
  login?: LoginStatus;
}

/** Friendly, plain-language text for each install phase. */
const PHASE_TEXT: Record<string, string> = {
  idle: "Getting ready.",
  installing: "Installing the AI brain. This can take a minute.",
  "installing-fallback": "Still working. Trying another way to finish the install.",
  verifying: "Almost there. Checking the install worked.",
  done: "Install finished.",
  failed: "The install did not finish.",
};

export default function ClaudeStep({
  onDone,
  embedded = false,
}: {
  onDone?: () => void;
  /** Embedded inside the first-run wizard's connect step: the wizard owns the
   *  forward navigation (its own "Next"), so the signed-in state drops the
   *  redundant "Done" button and just confirms. Install + sign-in actions stay
   *  — those ARE the in-app flow the wizard now hosts. */
  embedded?: boolean;
}) {
  const name = usePersonaName();
  const [connection, setConnection] = useState<Connection>("unknown");
  const [installing, setInstalling] = useState(false);
  const [phase, setPhase] = useState<string>("idle");
  const [logTail, setLogTail] = useState<string>("");
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInNote, setSignInNote] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginStatus>({ state: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Learn the current connection state on mount (missing / signed-out / signed-in).
  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/setup/claude/install");
      const j: InstallStatus = await r.json();
      setConnection(j.connection);
      setPhase(j.phase);
      setLogTail(j.logTail || "");
      if (j.login) setLogin(j.login);
      return j;
    } catch {
      setConnection("unknown");
      return null;
    }
  }, []);

  useEffect(() => {
    loadStatus();
    return () => stopPolling();
  }, [loadStatus, stopPolling]);

  // Poll the install route while an install runs; stop on done and refresh the
  // connection state so the screen advances to sign-in (or shows the failure).
  const beginPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/setup/claude/install");
        const j: InstallStatus = await r.json();
        setPhase(j.phase);
        setLogTail(j.logTail || "");
        if (j.done) {
          stopPolling();
          setInstalling(false);
          setConnection(j.connection);
          if (!j.ok) {
            setError(
              "The install did not finish. Nothing on your Mac was changed. You can try again, or ask for help on the call.",
            );
          }
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
  }, [stopPolling]);

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setPhase("installing");
    try {
      const r = await fetch("/api/setup/claude/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok) {
        setInstalling(false);
        setError("Could not start the install. Please try again.");
        return;
      }
      beginPolling();
    } catch {
      setInstalling(false);
      setError("Could not start the install. Check your internet and try again.");
    }
  }, [beginPolling]);

  // Poll the install route for the live login state + connection while a sign
  // in is in flight. Stops when the connection flips to signed-in (the step goes
  // green) or the login state settles on failed.
  const beginLoginPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/setup/claude/install");
        const j: InstallStatus = await r.json();
        if (j.login) setLogin(j.login);
        setConnection(j.connection);
        if (j.connection === "signed-in" || j.login?.state === "failed") {
          stopPolling();
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
  }, [stopPolling]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setSignInNote(null);
    setLogin({ state: "starting" });
    try {
      const r = await fetch("/api/setup/claude/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await r.json();
      if (j.spawned) {
        // The PTY driver (or blind fallback) is now running; poll for the OAuth
        // URL and for completion.
        beginLoginPolling();
      } else {
        setLogin({ state: "failed" });
        setSignInNote(
          "The sign in could not start on this computer. If the browser did not open, ask for help on the call.",
        );
      }
    } catch {
      setLogin({ state: "failed" });
      setSignInNote("Could not start the sign in just now. Please try again.");
    } finally {
      setSigningIn(false);
    }
  }, [beginLoginPolling]);

  /* ---------------------------------------------------------------- screens */

  // signed-in — nothing to do.
  if (connection === "signed-in") {
    return (
      <div className="onb-step">
        <h2>{name}{" "}is connected to Claude</h2>
        <p>
          {name}{" "}can reach its brain and reply with real answers. This step is
          done.
        </p>
        {!embedded && (
          <div className="onb-actions">
            <button className="onb-btn onb-btn-primary" onClick={() => onDone?.()}>
              Done
            </button>
          </div>
        )}
      </div>
    );
  }

  // signed-out — install is present, just needs a sign-in.
  if (connection === "signed-out") {
    // Phase B — the PTY driver captured the OAuth URL: show it as a big button.
    const urlReady = login.state === "url-ready" && !!login.url;
    // The PTY path could not surface a URL and fell over to the blind spawn (or
    // is mid-blind-spawn): show the Phase A "your browser should have opened" UX.
    const blindFallback = login.method === "blind" || login.state === "failed";
    // A sign in is running (PTY started, waiting on the browser round-trip).
    const waiting =
      !urlReady &&
      !blindFallback &&
      (login.state === "starting" || login.state === "waiting" || signingIn);

    return (
      <div className="onb-step">
        <h2>Sign in to Claude</h2>
        <p>
          The AI brain is installed. Now sign in with your OWN Claude account so
          {" "}{name}{" "}can think with it. When you tap the button, your web
          browser opens the Claude sign in page.
        </p>

        {urlReady && (
          <div className="onb-notice" style={{ marginTop: 4 }}>
            <p style={{ marginTop: 0 }}>
              Your sign in page is ready. Tap the button to open it, sign in with
              your own account, then come back here. This page turns green on its
              own once you are signed in.
            </p>
            <div className="onb-actions">
              <a
                className="onb-btn onb-btn-primary"
                href={login.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the sign-in page
              </a>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 0 }}>
              Your browser may have opened it already. If it did, you can use that
              window instead.
            </p>
          </div>
        )}

        {waiting && (
          <WorkingGlow lines={["Getting your sign in page ready. This takes a few seconds."]} />
        )}

        {urlReady && (
          <div style={{ marginTop: 12 }}>
            <WorkingGlow lines={["Waiting for you to finish signing in."]} />
          </div>
        )}

        {signInNote && <div className="onb-backend-note">{signInNote}</div>}

        {/* Initial action (before a URL is ready) + the blind-spawn fallback UX. */}
        {!urlReady && (
          <>
            {blindFallback && (
              <div className="onb-backend-note">
                A browser window should have opened for the Claude sign in. Finish
                signing in there with your own account, then tap the button below.
              </div>
            )}
            <div className="onb-actions">
              <button
                className="onb-btn onb-btn-primary"
                onClick={signIn}
                disabled={signingIn || waiting}
              >
                {signingIn || waiting ? "Opening sign in…" : "Open sign in"}
              </button>
              <button className="onb-btn" onClick={() => onDone?.()}>
                I signed in, check again
              </button>
            </div>
          </>
        )}

        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">If something looks off</div>
            <ul className="onb-notice-points">
              <li>The browser did not open? Wait a moment, then tap Open sign in again.</li>
              <li>Use your OWN Claude account. This is the account {name}{" "}will think with.</li>
              <li>Signed in on the browser? Come back here and tap I signed in, check again.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // missing (or unknown) — install the CLI first.
  return (
    <div className="onb-step">
      <h2>Install {name}&rsquo;s AI brain</h2>
      <p>
        {name}{" "}thinks with Claude. This adds the Claude tool to {name}&rsquo;s
        own folder on this Mac. There is no separate download and no password, and
        nothing changes system wide.
      </p>

      {installing && (
        <WorkingGlow lines={[PHASE_TEXT[phase] ?? "Working."]} />
      )}

      {error && <div className="onb-error">{error}</div>}

      <div className="onb-actions">
        <button
          className="onb-btn onb-btn-primary"
          onClick={install}
          disabled={installing}
        >
          {installing ? "Installing…" : error ? "Try again" : "Install the AI brain"}
        </button>
      </div>

      {logTail && (
        <div className="onb-notice" style={{ marginTop: 18 }}>
          <button
            className="vcstep-branch-toggle"
            aria-expanded={showLog}
            onClick={() => setShowLog((v) => !v)}
          >
            Show setup details
          </button>
          {showLog && (
            <pre
              style={{
                marginTop: 10,
                maxHeight: 200,
                overflow: "auto",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--text-dim)",
              }}
            >
              {logTail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
