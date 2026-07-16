"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The "Usage" tab in Settings (RETRO USAGE). A retrospective view over the data
 * this install already records: which models ran, how many turns and tokens,
 * rolling quota consumption, voice/TTS calls, and applied updates, per day and
 * per model, with plain-language takeaways.
 *
 * Owner introspection of LOCAL data only. Everything comes from
 * GET /api/usage/retro, which reads files under data/ and makes no network
 * call. Copy is plain language, no dashes. Trend lines are inline SVG (no chart
 * dependency); takeaways are computed server-side from the aggregates by plain
 * rules, never an LLM call.
 */

interface Bucket {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}
interface DayRow extends Bucket {
  day: string;
}
interface ModelRow extends Bucket {
  model: string;
  provider: string;
  share: number;
}
interface Retro {
  days: number;
  range: { from: string; to: string } | null;
  totals: Bucket;
  byDay: DayRow[];
  byModel: ModelRow[];
  tts: { premium: number; local: number; total: number };
  updates: { total: number; byDay: Array<{ day: string; count: number }> };
  quota: { last5h: Bucket; last7d: Bucket };
  takeaways: string[];
}

function fmt(n: number): string {
  return n.toLocaleString();
}
function fmtCost(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Inline SVG sparkline over a series of day values. No chart dependency. */
function Sparkline({
  values,
  label,
}: {
  values: number[];
  label: string;
}) {
  const w = 260;
  const h = 44;
  const pad = 3;
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className="usage-spark"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${label} trend`}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function UsagePanel() {
  const [data, setData] = useState<Retro | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    fetch("/api/usage/retro?days=30")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j: Retro) => {
        if (live) setData(j);
      })
      .catch(() => {
        if (live) setErr("Could not load usage just now. Try again in a moment.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const turnSeries = useMemo(() => (data ? data.byDay.map((d) => d.turns) : []), [data]);
  const costSeries = useMemo(() => (data ? data.byDay.map((d) => d.costUsd) : []), [data]);

  if (loading) {
    return (
      <div className="settings-field">
        <div className="settings-help">Loading your usage…</div>
      </div>
    );
  }
  if (err || !data) {
    return (
      <div className="settings-field">
        <div className="onb-error">{err ?? "No usage to show."}</div>
      </div>
    );
  }

  const empty = data.totals.turns === 0;

  return (
    <>
      <div className="settings-field">
        <div className="settings-label">Usage over the last {data.days} days</div>
        <div className="settings-help">
          A look back at how this ran, built only from what is already saved on this Mac.
          Nothing here is sent anywhere.
          {data.range ? ` Covers ${data.range.from} to ${data.range.to}.` : ""}
        </div>
      </div>

      {empty ? (
        <div className="settings-field">
          <div className="settings-help">
            No usage has been recorded yet. Run a few turns and check back.
          </div>
        </div>
      ) : (
        <>
          {/* Headline totals */}
          <div className="settings-field usage-stat-grid">
            <div className="usage-stat">
              <div className="usage-stat-num">{fmt(data.totals.turns)}</div>
              <div className="usage-stat-cap">turns</div>
            </div>
            <div className="usage-stat">
              <div className="usage-stat-num">{fmt(data.totals.outputTokens)}</div>
              <div className="usage-stat-cap">output tokens</div>
            </div>
            <div className="usage-stat">
              <div className="usage-stat-num">{fmtCost(data.totals.costUsd)}</div>
              <div className="usage-stat-cap">reported cost</div>
            </div>
            <div className="usage-stat">
              <div className="usage-stat-num">{fmt(data.tts.total)}</div>
              <div className="usage-stat-cap">voice replies</div>
            </div>
          </div>

          {/* Trend lines */}
          <div className="settings-field">
            <div className="settings-checklist-head">Turns per day</div>
            <Sparkline values={turnSeries} label="Turns per day" />
            <div className="settings-checklist-head" style={{ marginTop: "0.75rem" }}>
              Reported cost per day
            </div>
            <Sparkline values={costSeries} label="Cost per day" />
          </div>

          {/* Per-model table */}
          <div className="settings-field">
            <div className="settings-checklist-head">By model</div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="usage-num">Turns</th>
                  <th className="usage-num">Share</th>
                  <th className="usage-num">Out tokens</th>
                  <th className="usage-num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={`${m.provider}/${m.model}`}>
                    <td>
                      {m.model}
                      <span className="usage-provider"> {m.provider}</span>
                    </td>
                    <td className="usage-num">{fmt(m.turns)}</td>
                    <td className="usage-num">{pct(m.share)}</td>
                    <td className="usage-num">{fmt(m.outputTokens)}</td>
                    <td className="usage-num">{fmtCost(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Rolling quota consumption + TTS + updates */}
          <div className="settings-field">
            <div className="settings-checklist-head">Recent load and events</div>
            <div className="settings-help">
              Claude Max is a rolling window, not a fixed allowance, so there is no hard cap
              to show. These are the last 5 hours and last 7 days of measured load.
            </div>
            <table className="usage-table">
              <tbody>
                <tr>
                  <td>Last 5 hours</td>
                  <td className="usage-num">{fmt(data.quota.last5h.turns)} turns</td>
                  <td className="usage-num">{fmtCost(data.quota.last5h.costUsd)}</td>
                </tr>
                <tr>
                  <td>Last 7 days</td>
                  <td className="usage-num">{fmt(data.quota.last7d.turns)} turns</td>
                  <td className="usage-num">{fmtCost(data.quota.last7d.costUsd)}</td>
                </tr>
                <tr>
                  <td>Voice replies (all time)</td>
                  <td className="usage-num">{fmt(data.tts.premium)} premium</td>
                  <td className="usage-num">{fmt(data.tts.local)} local</td>
                </tr>
                <tr>
                  <td>Updates applied</td>
                  <td className="usage-num">{fmt(data.updates.total)}</td>
                  <td className="usage-num" />
                </tr>
              </tbody>
            </table>
          </div>

          {/* Takeaways */}
          {data.takeaways.length > 0 && (
            <div className="settings-field settings-checklist">
              <div className="settings-checklist-head">Takeaways</div>
              <ul className="settings-recent-list">
                {data.takeaways.map((t, i) => (
                  <li key={i} className="settings-recent-item">
                    <span className="settings-recent-msg">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
