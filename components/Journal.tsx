"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NavDesk, BottomNav } from "./AppNav";
import { usePersonaName } from "@/components/usePersonaName";

/**
 * Journal — the searchable memory ledger. It does not replay chat: it shows
 * what actually ran (act-mode tool calls, recorded by lib/journal.ts), grouped
 * into daily digests, searchable, and linked back to the room each action
 * happened in. Everything here is REAL logged data; the page adds structure,
 * never content.
 */

interface JournalEntry {
  ts: number;
  threadId: string;
  tool: string;
  summary: string;
}

interface ThreadMeta {
  id: string;
  title: string;
}

interface DayGroup {
  key: string; // YYYY-MM-DD
  date: Date;
  entries: JournalEntry[];
  rooms: number;
  tools: number;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Journal() {
  // Live persona name: a customized install says "Anna", not the brand.
  const ASSISTANT_NAME = usePersonaName();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/journal")
        .then((r) => r.json())
        .then((j) => setEntries(j.entries || []))
        .catch(() => setEntries([])),
      fetch("/api/threads")
        .then((r) => r.json())
        .then((j) => setThreads(j.threads || []))
        .catch(() => setThreads([])),
    ]).finally(() => setLoaded(true));
  }, []);

  const titleOf = useMemo(() => {
    const map = new Map(threads.map((t) => [t.id, t.title]));
    return (id: string) => map.get(id) || null;
  }, [threads]);

  // Search operates on the real ledger: tool names, summaries, room titles.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.tool.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        (titleOf(e.threadId) || "").toLowerCase().includes(q)
    );
  }, [entries, query, titleOf]);

  const days: DayGroup[] = useMemo(() => {
    const byDay = new Map<string, JournalEntry[]>();
    for (const e of filtered) {
      const k = dayKey(e.ts);
      const arr = byDay.get(k);
      if (arr) arr.push(e);
      else byDay.set(k, [e]);
    }
    return [...byDay.entries()]
      .map(([key, es]) => ({
        key,
        date: new Date(es[0].ts),
        entries: [...es].sort((a, b) => a.ts - b.ts),
        rooms: new Set(es.map((e) => e.threadId)).size,
        tools: new Set(es.map((e) => e.tool)).size,
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [filtered]);

  const day = days.find((d) => d.key === selectedDay) || days[0] || null;

  return (
    <div className="app vc-app">
      <NavDesk
        active="journal"
        captureLabel="Workspace memory"
        captureTitle="Everything worth keeping"
        captureBody={`Actions ${ASSISTANT_NAME} actually ran are indexed here, not every line of chat.`}
        footer={`${entries.length} journal entr${entries.length === 1 ? "y" : "ies"}`}
      />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Journal · daily ledger</span>
            <h1>A record you can use</h1>
          </div>
          <div className="vc-header-actions">
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>

        <div className="vcj-layout">
          <article className="daily-page" aria-label="Daily digest">
            {!day ? (
              <div className="vcj-empty">
                {!loaded
                  ? "Reading the ledger…"
                  : query
                    ? "Nothing in the ledger matches that search."
                    : `Nothing recorded yet. When ${ASSISTANT_NAME} acts (auto mode), every tool call lands here.`}
              </div>
            ) : (
              <>
                <header className="journal-mast">
                  <div className="journal-day">
                    {String(day.date.getDate()).padStart(2, "0")}
                  </div>
                  <div className="journal-heading">
                    <span className="micro-label">
                      {day.date.toLocaleDateString("en-US", {
                        month: "long",
                        year: "numeric",
                      })}
                    </span>
                    <h2>
                      {day.date.toLocaleDateString("en-US", { weekday: "long" })}
                      ’s digest
                    </h2>
                    <p>
                      Recorded by {ASSISTANT_NAME} · {day.entries.length} action
                      {day.entries.length === 1 ? "" : "s"} · {day.rooms} room
                      {day.rooms === 1 ? "" : "s"} touched
                    </p>
                  </div>
                </header>

                <p className="digest-lede">
                  {ASSISTANT_NAME}{" "}ran{" "}
                  <strong>
                    {day.entries.length} logged action
                    {day.entries.length === 1 ? "" : "s"}
                  </strong>{" "}
                  across {day.rooms} room{day.rooms === 1 ? "" : "s"}, using{" "}
                  {day.tools} tool{day.tools === 1 ? "" : "s"}. Every line below
                  links back to the room it happened in.
                </p>

                <section className="vcj-section" aria-label="Logged actions">
                  <span className="micro-label">What actually ran</span>
                  <h3>Actions, in order</h3>
                  {day.entries.map((e, i) => {
                    const title = titleOf(e.threadId);
                    return (
                      <div className="ledger-item" key={`${e.ts}-${i}`}>
                        <strong>{e.tool}</strong>
                        <span className="ledger-summary">{e.summary}</span>
                        <span className="ledger-meta">
                          <span>{fmtTime(e.ts)}</span>
                          <Link href={`/?room=${encodeURIComponent(e.threadId)}`}>
                            {title ? `open “${title}”` : "open source room"} →
                          </Link>
                        </span>
                      </div>
                    );
                  })}
                </section>
              </>
            )}
          </article>

          <aside className="search-ledger" aria-label="Search the journal">
            <form
              className="ledger-search"
              onSubmit={(e) => e.preventDefault()}
            >
              <label htmlFor="ledger-query">Search the ledger</label>
              <div className="search-box">
                <span aria-hidden="true">⌕</span>
                <input
                  id="ledger-query"
                  value={query}
                  placeholder="Search tools, files, rooms…"
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelectedDay(null);
                  }}
                />
              </div>
            </form>

            <section className="ledger-index" aria-label="Recent days">
              <span className="micro-label">Recent ledger</span>
              <h3>Days with consequence</h3>
              {days.length === 0 && (
                <p style={{ color: "var(--text-faint)", fontSize: 12, margin: "6px 0 0" }}>
                  No recorded days{query ? " match" : " yet"}.
                </p>
              )}
              {days.slice(0, 8).map((d) => (
                <button
                  key={d.key}
                  className={`index-entry ${day && d.key === day.key ? "selected" : ""}`}
                  onClick={() => setSelectedDay(d.key)}
                >
                  <span className="index-date">
                    {d.date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "2-digit",
                    })}
                  </span>
                  <span className="index-copy">
                    <strong>
                      {d.entries.length} action{d.entries.length === 1 ? "" : "s"}
                    </strong>
                    <span>
                      {d.rooms} room{d.rooms === 1 ? "" : "s"} · {d.tools} tool
                      {d.tools === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              ))}
            </section>

            <div className="vcj-note">
              <strong>Recorded, not written.</strong> Every entry is logged
              automatically when {ASSISTANT_NAME}{" "}acts in auto mode. Nothing
              here is a summary she authored after the fact. Secrets are
              redacted before anything is written.
            </div>
          </aside>
        </div>
        <BottomNav active="journal" />
      </main>
    </div>
  );
}
