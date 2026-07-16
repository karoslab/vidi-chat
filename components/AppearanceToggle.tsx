"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Frost appearance control — System / Light / Dark, persisted in localStorage
 * under `vidi:appearance` (read pre-hydration by app/layout.tsx's THEME_INIT so
 * there is no flash of the wrong theme). Applying a choice only mutates the
 * <html data-theme> attribute + the stored value: it never moves layout, drops
 * focus, or touches app state (handoff §7 requirement 7). "System" removes the
 * attribute so globals.css's prefers-color-scheme media query governs and
 * reacts live to OS changes.
 */
type Choice = "system" | "light" | "dark";

const KEY = "vidi:appearance";

function apply(choice: Choice) {
  const el = document.documentElement;
  if (choice === "light" || choice === "dark") el.setAttribute("data-theme", choice);
  else el.removeAttribute("data-theme");
}

const OPTIONS: { id: Choice; label: string; glyph: string }[] = [
  { id: "light", label: "Light", glyph: "☀" },
  { id: "system", label: "System", glyph: "◐" },
  { id: "dark", label: "Dark", glyph: "☾" },
];

export function AppearanceToggle({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Choice | null;
      if (saved === "light" || saved === "dark" || saved === "system") setChoice(saved);
    } catch {
      /* private mode / storage disabled — stay on system */
    }
  }, []);

  const pick = useCallback((next: Choice) => {
    setChoice(next);
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  return (
    <div
      className={`appearance-toggle ${compact ? "compact" : ""}`}
      role="radiogroup"
      aria-label="Appearance"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={choice === o.id}
          className={`appearance-opt ${choice === o.id ? "on" : ""}`}
          title={o.label}
          aria-label={o.label}
          onClick={() => pick(o.id)}
        >
          <span aria-hidden="true" className="appearance-glyph">
            {o.glyph}
          </span>
          {!compact && <span className="appearance-label">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export default AppearanceToggle;
