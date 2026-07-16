"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Spotlight tour (2026-07-12): right after first-run onboarding closes, the
 * app itself gets pointed at — the page dims and a soft ring spotlights the
 * REAL composer, the REAL mic, the REAL settings entry, each with one plain
 * sentence. A non-technical person never has to map a description onto the
 * screen; the screen shows them. Runs once (vidi:tour-done), skippable at any
 * moment, recomputes on resize, and skips any anchor that isn't on screen
 * (e.g. no mic support).
 */

export const TOUR_DONE_KEY = "vidi:tour-done";

interface TourStep {
  anchor: string;
  title: string;
  body: string;
}

function stepsFor(personaName: string): TourStep[] {
  return [
    {
      anchor: '[data-tour="composer"]',
      title: "Talk here",
      body: `This box is all you really need. Type to ${personaName} the way you'd text a friend.`,
    },
    {
      anchor: '[data-tour="mic"]',
      title: "Or just say it",
      body: "Tap this and speak. She answers out loud.",
    },
    {
      anchor: '[data-tour="settings"]',
      title: "Everything else",
      body: "Names, voice, and setup live in here whenever you want them.",
    },
  ];
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function SpotlightTour({
  personaName,
  onClose,
}: {
  personaName: string;
  onClose: () => void;
}) {
  const steps = useMemo(() => stepsFor(personaName), [personaName]);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  // Bumped to force the resolver to re-measure (setI(n => n) would bail out).
  const [tick, setTick] = useState(0);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(TOUR_DONE_KEY, "1");
    } catch {
      /* private mode: the tour just shows again next time, harmless */
    }
    onClose();
  }, [onClose]);

  // Resolve the current step's anchor; skip forward past anything invisible.
  useEffect(() => {
    let step = i;
    while (step < steps.length) {
      const el = document.querySelector(steps[step].anchor);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        if (step !== i) setI(step);
        const pad = 8;
        setRect({
          top: r.top - pad,
          left: r.left - pad,
          width: r.width + pad * 2,
          height: r.height + pad * 2,
        });
        return;
      }
      step += 1;
    }
    finish();
  }, [i, steps, finish, tick]);

  // Keep the spotlight glued to the anchor across resizes/layout shifts.
  useEffect(() => {
    const recompute = () => setTick((t) => t + 1);
    window.addEventListener("resize", recompute);
    const iv = setInterval(recompute, 600); // cheap guard for async layout
    return () => {
      window.removeEventListener("resize", recompute);
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "Enter") setI((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  if (!rect) return null;
  const step = steps[i];
  if (!step) return null;

  // Place the card above the anchor when the anchor sits in the lower half.
  const below = rect.top + rect.height / 2 < window.innerHeight / 2;
  const cardStyle: React.CSSProperties = {
    left: Math.min(Math.max(rect.left, 16), window.innerWidth - 336),
    ...(below
      ? { top: rect.top + rect.height + 14 }
      : { bottom: window.innerHeight - rect.top + 14 }),
  };

  return (
    <div className="tour-layer" role="dialog" aria-label="Quick look around">
      <div
        className="tour-spot"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      <div className="tour-card" style={cardStyle}>
        <p className="tour-title">{step.title}</p>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button className="onb-btn onb-btn-skip" onClick={finish}>
            Skip
          </button>
          <span className="tour-count">
            {i + 1} of {steps.length}
          </span>
          <button className="onb-btn onb-btn-primary" onClick={() => (i + 1 >= steps.length ? finish() : setI(i + 1))}>
            {i + 1 >= steps.length ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
