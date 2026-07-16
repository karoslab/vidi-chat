"use client";

import { useEffect, useState } from "react";

interface OverlayAgent {
  name: string;
  status: "idle" | "working" | "error";
  turns: number;
  tokensOut: number;
}
interface OverlayData {
  day: number;
  revenueUsd: number;
  goalUsd: number;
  workingCount: number;
  agents: OverlayAgent[];
}

/**
 * Crew Cam — the fleet as an OBS browser source. Transparent background so it
 * composites over the screen capture; polls the sanitized /api/overlay every
 * 2s. Read-only; no controls, no secrets.
 */
export default function Overlay() {
  const [data, setData] = useState<OverlayData | null>(null);

  // OBS captures the page's alpha — force a transparent background on BOTH the
  // html and body elements (globals.css paints an opaque bg on body; the html
  // element keeps its default too, so both must be cleared to composite).
  useEffect(() => {
    const prevBody = document.body.style.background;
    const prevHtml = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.background = prevHtml;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/overlay", { cache: "no-store" });
        if (alive && r.ok) setData(await r.json());
      } catch {
        /* keep last frame on a hiccup */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!data) return <div className="cc-root" />;

  const pct = data.goalUsd > 0 ? Math.min(100, (data.revenueUsd / data.goalUsd) * 100) : 0;
  const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

  return (
    <div className="cc-root">
      <div className="cc-card">
        <div className="cc-header">
          <span className="cc-logo">V</span>
          <span className="cc-day">Day {data.day}</span>
          <span className="cc-money">
            {money(data.revenueUsd)} <span className="cc-goal">/ {money(data.goalUsd)}</span>
          </span>
        </div>
        <div className="cc-bar">
          <div className="cc-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="cc-agents">
          {data.agents.length === 0 ? (
            <div className="cc-empty">fleet idle</div>
          ) : (
            data.agents.map((a) => (
              <div key={a.name} className={`cc-agent ${a.status}`}>
                <span className={`cc-dot ${a.status}`} />
                <span className="cc-name">{a.name}</span>
                <span className="cc-meta">
                  {a.status === "working" ? "working" : a.status === "error" ? "error" : "idle"}
                  {a.tokensOut > 0 ? ` · ${(a.tokensOut / 1000).toFixed(1)}k` : ""}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
