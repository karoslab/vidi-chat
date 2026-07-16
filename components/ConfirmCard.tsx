"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonaName } from "@/components/usePersonaName";

/**
 * The in-browser confirm card — the browser-first surface for approving a
 * consequential action ({send email, create calendar event, hands, write-file})
 * that Vidi has parked in the one-slot confirm queue (lib/confirm.ts). Until now
 * only the Swift overlay or a spoken "confirm" could approve; a browser-first
 * non-owner user had no way to see or approve a parked action. This closes that
 * WITHOUT weakening the nonce gate, TTL, plan-mutation invalidation, single-use
 * property, or payload redaction — every one of those still lives server-side in
 * confirmPending; the card only reads the redacted description + nonce and hands
 * the nonce back on Approve.
 *
 * Wiring (session-token gated; the layout fetch-shim attaches
 * x-vidi-session-token to same-origin /api fetches automatically):
 *   - poll:    GET  /api/confirm/pending → { pending: {description,nonce,kind,expiresAt}|null }
 *   - approve: POST /api/confirm/approve { nonce } → { ran, text }   (runs it)
 *   - reject:  POST /api/confirm/reject             → { cancelled, text } (clears it)
 *
 * Rendered for EVERY install (owner and non-owner alike) — deliberately NOT
 * gated behind fleet/owner surfacing, because the non-owner browser user is the
 * whole reason this exists.
 */

interface Pending {
  description: string;
  nonce: string;
  kind: string;
  expiresAt: number;
}

/** kind → a plain "what this touches" label (never the raw payload). */
function kindLabel(kind: string): string {
  switch (kind) {
    case "gws-email":
      return "Email";
    case "gws-calendar":
      return "Calendar";
    case "write-file":
      return "Files";
    case "hands":
      return "Screen control";
    default:
      return "Action";
  }
}

/** Seconds left until expiry, floored at 0. */
function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function ConfirmCard() {
  const ASSISTANT_NAME = usePersonaName();
  const [pending, setPending] = useState<Pending | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/confirm/pending", { cache: "no-store" });
      if (!r.ok) return; // transient 401/500 — keep the last known state, don't flicker
      const j = (await r.json()) as { pending: Pending | null };
      if (!mounted.current) return;
      // A live receipt stays visible until the next real park replaces it.
      if (receipt && !j.pending) return;
      setPending(j.pending);
      if (j.pending) setReceipt(null);
    } catch {
      /* offline / transient — keep the last known state */
    }
  }, [receipt]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const poll = setInterval(refresh, 2000);
    const tick = setInterval(() => {
      if (mounted.current) setNow(Date.now());
    }, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const approve = useCallback(async () => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      const r = await fetch("/api/confirm/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: pending.nonce }),
      });
      const j = (await r.json()) as { ran?: boolean; text?: string };
      if (!mounted.current) return;
      setPending(null);
      setReceipt(j.text || (j.ran ? "Done." : "Nothing is waiting on you."));
    } catch {
      if (mounted.current) setReceipt("I could not reach that just now.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, pending]);

  const reject = useCallback(async () => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      await fetch("/api/confirm/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      /* ignore — the next poll reconciles true state */
    } finally {
      if (mounted.current) {
        setPending(null);
        setReceipt(null);
        setBusy(false);
      }
    }
  }, [busy, pending]);

  // A just-approved action leaves a short receipt in place of the card.
  if (!pending) {
    if (!receipt) return null;
    return (
      <div className="confirm-card" role="status" aria-live="polite">
        <span className="confirm-dot" aria-hidden="true" />
        <div className="confirm-body">
          <p className="confirm-receipt">{receipt}</p>
        </div>
        <button
          type="button"
          className="confirm-dismiss"
          title="Dismiss"
          onClick={() => setReceipt(null)}
        >
          Dismiss
        </button>
      </div>
    );
  }

  const left = secondsLeft(pending.expiresAt, now);
  const expired = left <= 0;

  return (
    <div className="confirm-card" role="alertdialog" aria-live="assertive" aria-label={`${ASSISTANT_NAME} needs your approval`}>
      <span className="confirm-dot" aria-hidden="true" />
      <div className="confirm-body">
        <span className="confirm-kind">{kindLabel(pending.kind)}</span>
        <p className="confirm-desc">{pending.description}</p>
        <p className="confirm-status">
          {/* The countdown is NOT the only signal: this line states the action
              has not happened yet, so a user who ignores the timer still knows. */}
          {expired
            ? "This request expired. Nothing happened."
            : `This has not happened yet. Waiting on you. ${left}s left.`}
        </p>
        {!expired && (
          <div className="confirm-actions">
            <button
              type="button"
              className="confirm-approve"
              onClick={approve}
              disabled={busy}
            >
              {busy ? "Working…" : "Approve"}
            </button>
            <button
              type="button"
              className="confirm-reject"
              onClick={reject}
              disabled={busy}
            >
              Not now
            </button>
          </div>
        )}
      </div>
      {expired && (
        <button
          type="button"
          className="confirm-dismiss"
          title="Dismiss"
          onClick={() => setPending(null)}
        >
          Dismiss
        </button>
      )}
      <span className="confirm-who" aria-hidden="true">
        {ASSISTANT_NAME}
      </span>
    </div>
  );
}
