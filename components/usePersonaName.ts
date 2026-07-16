"use client";

import { useEffect, useState } from "react";
import { ASSISTANT_NAME } from "@/lib/assistant-identity";

/**
 * The persona name a customized install answers to (2026-07-11 ruling: the
 * BRAND stays "Vidi" in the app title, launcher, and docs; this is only the
 * per-install self-name, e.g. "Anna").
 *
 * Starts at the brand default (so SSR and a config-fetch failure both render
 * "Vidi") and updates once /api/user-config answers. Also re-reads whenever
 * "vidi:user-config-changed" fires, so renaming the persona in Settings or
 * onboarding shows up everywhere immediately — no page reload. The
 * server-resolved value is already sanitized (writeEditableConfig strips
 * control chars), so it renders as text.
 */

export const USER_CONFIG_CHANGED_EVENT = "vidi:user-config-changed";

export function usePersonaName(): string {
  const [personaName, setPersonaName] = useState(ASSISTANT_NAME);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch("/api/user-config")
        .then((r) => r.json())
        .then((j) => {
          const value = j?.fields?.assistantName?.value;
          if (!cancelled && typeof value === "string" && value.trim()) {
            setPersonaName(value.trim());
          }
        })
        .catch(() => {
          /* keep the current name on a fetch failure */
        });
    };
    refresh();
    window.addEventListener(USER_CONFIG_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(USER_CONFIG_CHANGED_EVENT, refresh);
    };
  }, []);
  return personaName;
}
