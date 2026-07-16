"use client";

import { useEffect, useState } from "react";

/**
 * A quiet, dismissible banner shown in the main chat shell when an update is
 * available. Checks once per app load (cached), never nags: dismissing a
 * specific version is remembered in localStorage, so the same version never
 * shows again. Tapping "See what's new" opens Settings on the Updates tab.
 *
 * Copy is plain language, no dashes.
 */

const DISMISS_KEY = "vidi:update-banner-dismissed";

interface CheckResult {
  available: boolean;
  latest?: { version: string };
  notes?: string;
  devBuild?: boolean;
}

export default function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/update/check")
      .then((r) => r.json())
      .then((j: CheckResult) => {
        if (cancelled || !j.available || j.devBuild) return;
        const v = j.latest?.version ?? "";
        let dismissed = "";
        try {
          dismissed = localStorage.getItem(DISMISS_KEY) ?? "";
        } catch {
          /* private mode: just show it, it stays dismissible */
        }
        if (v && v === dismissed) return; // already waved off this version
        setVersion(v || "new");
        setNotes(j.notes ?? "");
      })
      .catch(() => {
        /* a failed check never shows a banner */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, version);
    } catch {
      /* private mode: dismiss for this session only */
    }
    setVersion(null);
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-copy">
        A new version of Vidi is ready.{notes ? ` ${notes}` : ""}
      </span>
      <span className="update-banner-actions">
        <button className="update-banner-open" onClick={onOpen}>
          See what's new
        </button>
        <button
          className="update-banner-dismiss"
          onClick={dismiss}
          title="Not now"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </span>
    </div>
  );
}
