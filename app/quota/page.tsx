import Link from "next/link";
import { readQuota } from "@/lib/quota";
import { getAssistantName } from "@/lib/user-config";
import { NavDesk, BottomNav } from "@/components/AppNav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vidi · Quota",
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function fmtCost(usd: number): string {
  return "$" + usd.toFixed(4);
}

const s = {
  page: {
    color: "var(--text)",
    fontFamily: "var(--sans)",
    padding: "24px 16px 80px",
  } as React.CSSProperties,
  inner: {
    maxWidth: 820,
    margin: "0 auto",
  } as React.CSSProperties,
  heading: {
    fontFamily: "var(--serif)",
    fontSize: 24,
    fontWeight: 600,
    color: "var(--text)",
    margin: "0 0 4px",
  } as React.CSSProperties,
  sub: {
    fontSize: 13,
    color: "var(--text-faint)",
    margin: "0 0 28px",
  } as React.CSSProperties,
  summary: {
    display: "flex",
    gap: 12,
    marginBottom: 32,
    flexWrap: "wrap" as const,
  },
  chip: {
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 18px",
  } as React.CSSProperties,
  chipLabel: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
    color: "var(--text-faint)",
    marginBottom: 4,
  },
  chipValue: {
    fontSize: 20,
    fontWeight: 700,
    fontFamily: "var(--mono)",
    color: "var(--amber)",
  } as React.CSSProperties,
  section: {
    marginBottom: 36,
  } as React.CSSProperties,
  sectionTitle: {
    fontFamily: "var(--serif)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--amber)",
    marginBottom: 12,
  } as React.CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    overflow: "hidden",
    fontSize: 13.5,
  } as React.CSSProperties,
  th: {
    padding: "9px 14px",
    textAlign: "left" as const,
    fontFamily: "var(--sans)",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "var(--text-faint)",
    background: "var(--bg-raised)",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  thR: {
    padding: "9px 14px",
    textAlign: "right" as const,
    fontFamily: "var(--sans)",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "var(--text-faint)",
    background: "var(--bg-raised)",
    borderBottom: "1px solid var(--border)",
  } as React.CSSProperties,
  td: {
    padding: "8px 14px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
  } as React.CSSProperties,
  tdR: {
    padding: "8px 14px",
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
    textAlign: "right" as const,
    fontFamily: "var(--mono)",
    fontSize: 13,
  } as React.CSSProperties,
  tdCost: {
    padding: "8px 14px",
    borderBottom: "1px solid var(--border)",
    textAlign: "right" as const,
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--amber)",
  } as React.CSSProperties,
  tdLast: {
    borderBottom: "none",
  } as React.CSSProperties,
  empty: {
    padding: "32px 24px",
    color: "var(--text-faint)",
    fontSize: 13.5,
    textAlign: "center" as const,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
  } as React.CSSProperties,
};

export default function QuotaPage() {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600_000;
  const entries = readQuota(sevenDaysAgo);

  // Per-day aggregation (UTC date string as key)
  const dayMap = new Map<
    string,
    { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }
  >();

  // Per-model aggregation
  const modelMap = new Map<
    string,
    { turns: number; inputTokens: number; outputTokens: number; costUsd: number }
  >();

  for (const e of entries) {
    const date = new Date(e.ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

    const day = dayMap.get(date) ?? { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    day.turns++;
    day.inputTokens += e.inputTokens ?? 0;
    day.outputTokens += e.outputTokens ?? 0;
    day.cacheReadTokens += e.cacheReadTokens ?? 0;
    day.costUsd += e.costUsd ?? 0;
    dayMap.set(date, day);

    const model = e.model ?? "(unknown)";
    const m = modelMap.get(model) ?? { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    m.turns++;
    m.inputTokens += e.inputTokens ?? 0;
    m.outputTokens += e.outputTokens ?? 0;
    m.costUsd += e.costUsd ?? 0;
    modelMap.set(model, m);
  }

  // Sort days ascending by ts (map insertion is chronological since entries are oldest-first)
  const days = Array.from(dayMap.entries()).map(([date, v]) => ({ date, ...v }));
  const models = Array.from(modelMap.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const totalCost = entries.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const totalTurns = entries.length;
  const totalOutput = entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0);

  return (
    <div className="app vc-app">
      <NavDesk footer="Usage" />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Usage · last 7 days</span>
            <h1>What {getAssistantName()} has used</h1>
          </div>
          <div className="vc-header-actions">
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>
        <div className="vc-scroll" style={s.page}>
          <div style={s.inner}>
        <p style={s.sub}>API-equivalent cost, not money spent. Your subscription covers this.</p>

        <div style={s.summary}>
          <div style={s.chip}>
            <div style={s.chipLabel}>Total cost</div>
            <div style={s.chipValue}>{fmtCost(totalCost)}</div>
          </div>
          <div style={s.chip}>
            <div style={s.chipLabel}>Turns</div>
            <div style={s.chipValue}>{totalTurns}</div>
          </div>
          <div style={s.chip}>
            <div style={s.chipLabel}>Output tokens</div>
            <div style={s.chipValue}>{fmt(totalOutput)}</div>
          </div>
        </div>

        <div style={s.section}>
          <div style={s.sectionTitle}>By day</div>
          {days.length === 0 ? (
            <div style={s.empty}>No usage data in the last 7 days.</div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Date</th>
                  <th style={s.thR}>Turns</th>
                  <th style={s.thR}>Input</th>
                  <th style={s.thR}>Output</th>
                  <th style={s.thR}>Cache read</th>
                  <th style={s.thR}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d, i) => {
                  const last = i === days.length - 1;
                  const td = last ? { ...s.td, ...s.tdLast } : s.td;
                  const tdR = last ? { ...s.tdR, ...s.tdLast } : s.tdR;
                  const tdC = last ? { ...s.tdCost, ...s.tdLast } : s.tdCost;
                  return (
                    <tr key={d.date}>
                      <td style={td}>{d.date}</td>
                      <td style={tdR}>{d.turns}</td>
                      <td style={tdR}>{fmt(d.inputTokens)}</td>
                      <td style={tdR}>{fmt(d.outputTokens)}</td>
                      <td style={tdR}>{fmt(d.cacheReadTokens)}</td>
                      <td style={tdC}>{fmtCost(d.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={s.section}>
          <div style={s.sectionTitle}>By model</div>
          {models.length === 0 ? (
            <div style={s.empty}>No usage data in the last 7 days.</div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Model</th>
                  <th style={s.thR}>Turns</th>
                  <th style={s.thR}>Input</th>
                  <th style={s.thR}>Output</th>
                  <th style={s.thR}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => {
                  const last = i === models.length - 1;
                  const td = last ? { ...s.td, ...s.tdLast } : s.td;
                  const tdR = last ? { ...s.tdR, ...s.tdLast } : s.tdR;
                  const tdC = last ? { ...s.tdCost, ...s.tdLast } : s.tdCost;
                  return (
                    <tr key={m.model}>
                      <td style={td}>{m.model}</td>
                      <td style={tdR}>{m.turns}</td>
                      <td style={tdR}>{fmt(m.inputTokens)}</td>
                      <td style={tdR}>{fmt(m.outputTokens)}</td>
                      <td style={tdC}>{fmtCost(m.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
          </div>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
