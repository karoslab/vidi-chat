"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePersonaName } from "@/components/usePersonaName";
import { panicMicRelease } from "@/lib/mic-registry";

/**
 * The pause / resume affordance — a UI surface for the emergency stop that until
 * now only had a voice phrase and the CLI/file. It is deliberately plain: the
 * word "kill" never appears; the user sees "Pause" and "Resume".
 *
 *   - normal    → a small, quiet "Pause Vidi" pill (fixed, visible on desktop
 *                 and mobile alike).
 *   - paused    → a prominent top banner "Vidi is paused" with a Resume button.
 *
 * Wiring (see app/api/kill/route.ts):
 *   - state:  GET  /api/kill                       (session-token gated; the
 *             layout fetch-shim attaches x-vidi-session-token automatically).
 *   - pause:  POST /api/kill { action: "engage" }  (deliberately open — a
 *             stop-only fail-safe; confirmed first so it can't fire by accident).
 *   - resume: POST /api/kill { action: "clear" }   (capability grant — accepts
 *             the browser session token, which the shim provides).
 *
 * Rendered ONCE, at the app root, so there is exactly one poller and one banner
 * regardless of desk-vs-tabbar layout.
 */
export function PauseControl() {
  // Live persona name — the pill/banner say "Pause Anna" on a named install.
  const ASSISTANT_NAME = usePersonaName();
  // null = not yet known (render nothing — no flash of either state).
  const [engaged, setEngaged] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/kill", { cache: "no-store" });
      if (!r.ok) return; // leave the last known state; a transient 401/500 shouldn't flicker the UI
      const j = await r.json();
      if (mounted.current) setEngaged(j.engaged === true);
    } catch {
      /* offline / transient — keep the last known state */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const pause = useCallback(async () => {
    if (busy) return;
    const ok = window.confirm(
      `Pause ${ASSISTANT_NAME}? This stops all running work immediately. Nothing else is changed.`
    );
    if (!ok) return;
    // The emergency stop drops the mic instantly and locally, before the
    // network round-trip — Pause must never leave a hot mic behind.
    panicMicRelease("pause");
    setBusy(true);
    try {
      await fetch("/api/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "engage" }),
      });
      if (mounted.current) setEngaged(true);
    } catch {
      /* ignore — refresh reconciles true state */
    } finally {
      if (mounted.current) setBusy(false);
      refresh();
    }
  }, [busy, refresh]);

  const resume = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      if (r.ok && mounted.current) setEngaged(false);
    } catch {
      /* ignore — refresh reconciles true state */
    } finally {
      if (mounted.current) setBusy(false);
      refresh();
    }
  }, [busy, refresh]);

  if (engaged === null) return null;

  if (engaged) {
    return (
      <div className="vidi-paused-banner" role="alert">
        <span className="vidi-paused-dot" aria-hidden="true" />
        <span className="vidi-paused-text">
          <strong>{ASSISTANT_NAME} is paused.</strong> All running work was
          stopped. Nothing new will run until you resume.
        </span>
        <button
          type="button"
          className="vidi-resume-btn"
          onClick={resume}
          disabled={busy}
        >
          {busy ? "Resuming…" : "Resume"}
        </button>
      </div>
    );
  }

  return (
    <div className="vidi-pause-dock">
      <button
        type="button"
        className="vidi-pause-btn"
        onClick={pause}
        disabled={busy}
        title={`Pause ${ASSISTANT_NAME}, stop all running work`}
      >
        <span className="vidi-pause-glyph" aria-hidden="true" />
        Pause {ASSISTANT_NAME}
      </button>
    </div>
  );
}
