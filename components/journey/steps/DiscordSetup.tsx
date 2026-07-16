"use client";

import { useEffect, useState } from "react";

/**
 * Stage 5 — guided Discord webhook setup (the notification mirror).
 *
 * Customer words only: this connects a free Discord channel so the customer gets
 * a ping on their phone when there's work waiting. It is OPTIONAL and skippable
 * — the journey never blocks on it. Saving runs a MANDATORY test ping; the step
 * is not "connected" until that test message gets through.
 */

const STEPS: { n: number; text: string }[] = [
  { n: 1, text: "Open Discord (it's free). If you don't have an account, create one. It only takes a minute." },
  { n: 2, text: "Make your own server: press the plus on the left, then \"Create My Own\"." },
  { n: 3, text: "Open your channel's settings (hover the channel, click the gear)." },
  { n: 4, text: "Go to Integrations, then Webhooks, then \"New Webhook\"." },
  { n: 5, text: "Click \"Copy Webhook URL\", then paste it below." },
];

export function DiscordSetup({
  onConnected,
  onSkip,
  heading = "Get a ping on your phone",
}: {
  onConnected?: () => void;
  onSkip?: () => void;
  heading?: string;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/approvals/discord")
      .then((r) => r.json())
      .then((j) => {
        if (j.connected) setDone(true);
      })
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/approvals/discord", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.connected) {
        setDone(true);
        onConnected?.();
      } else {
        setError(j.error || "That didn't work. Copy the link again from Discord and paste it.");
      }
    } catch {
      setError("Something went wrong sending the test message. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="vc-discord-setup">
        <p className="vc-discord-done">
          Connected. You'll get a message in Discord whenever there's work waiting for your OK.
        </p>
      </div>
    );
  }

  return (
    <div className="vc-discord-setup">
      <div className="vc-discord-head">
        <span className="micro-label">Optional</span>
        <h3>{heading}</h3>
        <p>
          Connect a free Discord channel and Vidi will send you a message there
          when work is ready, when it goes live, and if something needs a look.
          You can always skip this and just use the desk here.
        </p>
      </div>

      <ol className="vc-discord-steps">
        {STEPS.map((s) => (
          <li key={s.n}>{s.text}</li>
        ))}
      </ol>

      <label className="vc-discord-label" htmlFor="discord-webhook">
        Paste your webhook link
      </label>
      <input
        id="discord-webhook"
        className="vc-discord-input"
        type="url"
        inputMode="url"
        placeholder="https://discord.com/api/webhooks/..."
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError(null);
        }}
        disabled={busy}
      />

      {error && <p className="vc-discord-error">{error}</p>}

      <div className="vc-discord-actions">
        <button
          className="vc-btn-solid"
          onClick={save}
          disabled={busy || !url.trim()}
        >
          {busy ? "Sending a test message…" : "Connect and test"}
        </button>
        {onSkip && (
          <button className="vc-btn-quiet" onClick={onSkip} disabled={busy}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

export default DiscordSetup;
