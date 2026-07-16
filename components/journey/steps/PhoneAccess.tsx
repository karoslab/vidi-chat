"use client";

import { useCallback, useState } from "react";
import { ASSISTANT_NAME } from "@/lib/assistant-identity";

/**
 * Journey Stage 6 — "Vidi on your phone" (the self-serve phone-browser path).
 *
 * Five screens, in customer words. We never say "tailnet", "MagicDNS", "serve",
 * or "proxy": the connection is "your private connection" and the phone address
 * is shown literally. The customer runs everything on his OWN Mac and his OWN
 * phone, signed in to his OWN free account.
 *
 *   1. install the connection app on the Mac (link + what to expect + fixes),
 *   2. sign in on the Mac,
 *   3. install + sign in on the phone (App Store link),
 *   4. turn phone access on (this re-checks readiness; the actual switch is the
 *      Vidi Helper menu's "Enable phone access", because a web page cannot flip
 *      the Mac's connection or restart the service itself),
 *   5. the payoff: this Mac's address and a BIG one-time code, with the plain
 *      instruction to open the address on the phone and type the code.
 *
 * INTEGRATION: rendered by the journey registry as the Stage-6 rich step screen,
 * wrapped by StepScreen's RICH_ACTIONS in <StepFrame step={phoneAccessStep} …>.
 * Self-contained (own onDone/onBack) so it builds standalone.
 */

type Screen = "mac-install" | "mac-signin" | "phone-setup" | "enable" | "payoff";

const DOWNLOAD_URL = "https://tailscale.com/download";
const IOS_APP_URL = "https://apps.apple.com/app/tailscale/id1470499037";

export default function PhoneAccess({
  onDone,
  onBack,
}: {
  onDone?: () => void;
  onBack?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("mac-install");
  const [checking, setChecking] = useState(false);
  const [notReady, setNotReady] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-check readiness after the customer says he turned phone access on in the
  // Vidi Helper menu. If the connection is on AND this service trusts the phone,
  // move to the payoff; otherwise show the plain Helper instruction. The page
  // cannot turn the connection on itself, so this is a check, not a switch.
  const checkReady = useCallback(async () => {
    setChecking(true);
    setNotReady(false);
    setError(null);
    try {
      const r = await fetch("/api/phone-access/status");
      const j = await r.json();
      if (j?.serveActive && j?.trustedHostSet) {
        if (j.deviceName) setAddress(j.deviceName);
        setScreen("payoff");
      } else {
        setNotReady(true);
      }
    } catch {
      setError("Could not check just now. Give it a few seconds and try again.");
    } finally {
      setChecking(false);
    }
  }, []);

  const mintCode = useCallback(async () => {
    setMinting(true);
    setError(null);
    try {
      const r = await fetch("/api/phone-access/mint-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error || "Could not make a code just now. Please try again.");
        return;
      }
      setCode(j.code ?? null);
      if (j.deviceName) setAddress(j.deviceName);
    } catch {
      setError("Could not make a code just now. Please try again.");
    } finally {
      setMinting(false);
    }
  }, []);

  /* ---------------------------------------------------------------- screens */

  if (screen === "mac-install") {
    return (
      <div className="onb-step">
        <h2>Vidi on your phone</h2>
        <p>
          You can open {ASSISTANT_NAME} in your phone's browser over your own
          private connection. First, set that connection up on this Mac. It is
          free, and only your own devices can use it.
        </p>
        <ul className="onb-caps">
          <li>Open the download page and get the app for your Mac.</li>
          <li>Open the app once. You should see a small icon appear in the top menu bar of your Mac.</li>
        </ul>
        <div className="onb-actions">
          {onBack && (
            <button className="onb-btn" onClick={onBack}>
              Back
            </button>
          )}
          <a className="onb-btn" href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
            Open the download page
          </a>
          <button className="onb-btn onb-btn-primary" onClick={() => setScreen("mac-signin")}>
            I installed it on my Mac
          </button>
        </div>
        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">If something looks off</div>
            <ul className="onb-notice-points">
              <li>The page did not open? Type this address into your browser: {DOWNLOAD_URL}</li>
              <li>You do not see the menu bar icon? Open the app again from your Applications folder.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "mac-signin") {
    return (
      <div className="onb-step">
        <h2>Sign in on your Mac</h2>
        <p>
          Click the connection icon in your Mac's top menu bar, then choose to
          sign in. Use "Sign in with Google" and pick your own account.
        </p>
        <ul className="onb-caps">
          <li>When it is done, the same menu shows your Mac as connected.</li>
          <li>Use the same account on your phone in the next step, so the two can find each other.</li>
        </ul>
        <div className="onb-actions">
          <button className="onb-btn" onClick={() => setScreen("mac-install")}>
            Back
          </button>
          <button className="onb-btn onb-btn-primary" onClick={() => setScreen("phone-setup")}>
            I signed in on my Mac
          </button>
        </div>
        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">If something looks off</div>
            <ul className="onb-notice-points">
              <li>No sign-in option? Click the menu bar icon once more, the sign-in choice is near the top.</li>
              <li>It asks which account? Choose your own, the same one you will use on the phone.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "phone-setup") {
    return (
      <div className="onb-step">
        <h2>Set up your phone</h2>
        <p>
          On your iPhone, install the same connection app from the App Store and
          sign in with the very same account you used on the Mac.
        </p>
        <ul className="onb-caps">
          <li>Open the App Store on your phone and get the app.</li>
          <li>Open it, then sign in with Google using your own account.</li>
          <li>Turn the connection on when the phone asks. You only do this once.</li>
        </ul>
        <div className="onb-actions">
          <button className="onb-btn" onClick={() => setScreen("mac-signin")}>
            Back
          </button>
          <a className="onb-btn" href={IOS_APP_URL} target="_blank" rel="noopener noreferrer">
            Open the App Store page
          </a>
          <button className="onb-btn onb-btn-primary" onClick={() => setScreen("enable")}>
            Done on my phone
          </button>
        </div>
        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">If something looks off</div>
            <ul className="onb-notice-points">
              <li>The page did not open on the phone? Search the App Store for the app by name.</li>
              <li>It signed you in as someone else? Sign out on the phone and sign in with your own account.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "enable") {
    return (
      <div className="onb-step">
        <h2>Turn phone access on</h2>
        <p>
          Now let this Mac hand your phone a safe way in. On your Mac, open the
          Vidi Helper menu and choose "Enable phone access". Then come back here
          and tap the button below.
        </p>

        {notReady && (
          <div className="onb-error">
            Phone access is not on yet. On your Mac, open the Vidi Helper menu,
            choose "Enable phone access", wait a few seconds, then tap "Check
            again".
          </div>
        )}
        {error && <div className="onb-error">{error}</div>}

        <div className="onb-actions">
          <button className="onb-btn" onClick={() => setScreen("phone-setup")}>
            Back
          </button>
          <button className="onb-btn onb-btn-primary" onClick={checkReady} disabled={checking}>
            {checking ? "Checking." : "I turned it on, check again"}
          </button>
        </div>
        <div className="onb-notice" style={{ marginTop: 18 }}>
          <div className="onb-notice-section">
            <div className="onb-notice-heading">Where is the Vidi Helper menu</div>
            <ul className="onb-notice-points">
              <li>It is the Vidi Helper app you used to set {ASSISTANT_NAME} up. Open it and pick "Enable phone access".</li>
              <li>Do not see that choice? Update the Vidi Helper app, then open it again.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // payoff
  return (
    <div className="onb-step">
      <h2>Open Vidi on your phone</h2>
      <p>
        You are ready. On your phone, open Safari, type the address below, then
        type the code. You only do this once, after that your phone stays signed
        in.
      </p>

      {address && (
        <div style={{ textAlign: "center", margin: "14px 0" }}>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 6 }}>
            The address to type on your phone
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "var(--text)",
              userSelect: "all",
              wordBreak: "break-all",
            }}
          >
            {address}
          </div>
        </div>
      )}

      {code ? (
        <div style={{ textAlign: "center", margin: "18px 0" }}>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>
            Then type this code
          </div>
          <div
            aria-label={`Your one-time code is ${code.split("").join(" ")}`}
            style={{
              fontSize: 40,
              fontWeight: 700,
              letterSpacing: "0.14em",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "var(--text)",
              userSelect: "all",
              wordBreak: "break-all",
            }}
          >
            {code}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            This code works once and lasts ten minutes. Need a fresh one? Tap the
            button below.
          </div>
        </div>
      ) : (
        <p>Tap the button to get your one-time code.</p>
      )}

      {error && <div className="onb-error">{error}</div>}

      <div className="onb-actions">
        <button className="onb-btn" onClick={mintCode} disabled={minting}>
          {minting ? "Making a code." : code ? "Make a fresh code" : "Get my code"}
        </button>
        <button className="onb-btn onb-btn-primary" onClick={() => onDone?.()}>
          Done
        </button>
      </div>
    </div>
  );
}
