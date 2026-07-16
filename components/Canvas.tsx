"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AgentNamePicker from "./AgentNamePicker";
import { validateCustomAgentName } from "@/lib/agent-name-input";
import { NavDesk, BottomNav } from "./AppNav";
import { usePersonaName } from "@/components/usePersonaName";

/**
 * Fleet — the production ledger. Runs are rows (agent · scope · status ·
 * current action · time · next step), not orbiting planets. Signal Studio
 * semantics: working = cyan/cobalt, review = violet, complete = green,
 * blocked/needs-you = signal red WITH the reason and a recovery action.
 */

type MissionTone = "working" | "review" | "done" | "queued" | "blocked";

/** Map a raw swarm worker status onto ledger semantics. Red is reserved for
 *  states where progress stops without a person (approval, failure). */
function workerLedger(w: SwarmWorker): {
  tone: MissionTone;
  pill: string;
  blockedNote?: { reason: string; recovery: string };
} {
  const s = w.status;
  if (s === "working")
    return { tone: "working", pill: w.rounds > 0 ? `Working · round ${w.rounds}` : "Working" };
  if (s === "pr-open") return { tone: "review", pill: "In review" };
  if (s === "merged") return { tone: "done", pill: "Merged" };
  if (s === "pending") return { tone: "queued", pill: "Queued" };
  if (s === "closed") return { tone: "queued", pill: "Closed" }; // terminal, quiet
  if (s === "pending-approval")
    return {
      tone: "blocked",
      pill: "Needs your approval",
      blockedNote: {
        reason: `PR #${w.pr ?? "?"} passed review and is waiting on you. Nothing merges without your sign-off.`,
        recovery: `Reply APPROVE PR ${w.pr ?? "n"} in Discord #research, or open the PR below.`,
      },
    };
  if (s === "needs-human")
    return {
      tone: "blocked",
      pill: "Needs a human",
      blockedNote: {
        reason: w.error || "The worker hit something it can't resolve alone.",
        recovery: "Open the PR / worker activity below and unblock it.",
      },
    };
  if (
    s === "failed" ||
    s === "rejected" ||
    s === "merge-failed" ||
    s === "review-error" ||
    s === "stalled"
  )
    return {
      tone: "blocked",
      pill: s === "stalled" ? "Stalled" : "Failed",
      blockedNote: {
        reason: w.error || `The run ended in “${s}”.`,
        recovery: "Check the worker activity below, then re-run or close it.",
      },
    };
  return { tone: "queued", pill: s };
}

interface FeedEvent {
  type: "user" | "delta" | "tool" | "done" | "error" | "system";
  ts: number;
  text?: string;
  tool?: string;
  summary?: string;
}
interface SwarmWorker {
  name: string | null;
  branch: string;
  task: string;
  status: string;
  pr: number | null;
  rounds: number;
  error?: string;
  activity: string[];
}
interface SwarmRepo {
  repo: string;
  updatedAt: number;
  workers: SwarmWorker[];
}

interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  mode: string;
  status: "idle" | "working" | "error";
  createdAt: number;
  lastActivity: number;
  turns: number;
  tokens: { input: number; output: number };
  feed: FeedEvent[];
  /** Set while this agent owes its answer to a chat thread that delegated
   *  the task; the fleet manager posts the reply back there on completion. */
  originThreadId?: string | null;
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Collapse a feed into renderable blocks: consecutive deltas coalesce into
 *  one growing assistant block; done replaces the live block with the final. */
function renderBlocks(feed: FeedEvent[]) {
  const blocks: { key: string; kind: string; text: string }[] = [];
  let acc = "";
  const flush = (i: number) => {
    if (acc) {
      blocks.push({ key: `a${i}`, kind: "assistant", text: acc });
      acc = "";
    }
  };
  feed.forEach((e, i) => {
    if (e.type === "delta") {
      acc += e.text || "";
    } else if (e.type === "done") {
      acc = e.text || acc;
      flush(i);
    } else if (e.type === "user") {
      flush(i);
      blocks.push({ key: `u${i}`, kind: "user", text: e.text || "" });
    } else if (e.type === "tool") {
      flush(i);
      blocks.push({ key: `t${i}`, kind: "tool", text: `${e.tool}${e.summary ? " · " + e.summary : ""}` });
    } else if (e.type === "error") {
      flush(i);
      blocks.push({ key: `e${i}`, kind: "error", text: e.text || "error" });
    } else if (e.type === "system") {
      flush(i);
      blocks.push({ key: `s${i}`, kind: "system", text: e.text || "" });
    }
  });
  flush(feed.length);
  return blocks;
}

const OWNER_COLORS = ["var(--cobalt)", "var(--room-violet)", "var(--room-magenta)", "var(--room-cyan)"];

/** One live agent as a ledger row. The interactive feed + prompt stay, folded
 *  into a disclosure so the board reads as a ledger first. */
function AgentMission({
  agent,
  index,
  onPrompt,
  onClose,
}: {
  agent: Agent;
  index: number;
  onPrompt: (id: string, text: string) => Promise<string | null>;
  onClose: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.feed]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setErr(null);
    const problem = await onPrompt(agent.id, t);
    if (problem) setErr(problem);
    else setText("");
  };

  const tone: MissionTone =
    agent.status === "working" ? "working" : agent.status === "error" ? "blocked" : "done";
  const pill =
    agent.status === "working" ? "Working" : agent.status === "error" ? "Failed" : "Ready";
  const lastTool = [...agent.feed].reverse().find((e) => e.type === "tool");

  return (
    <article className={`mission ${tone}`}>
      <div className="mission-state">
        <span className={`state-pill ${tone === "blocked" ? "alert" : tone}`}>{pill}</span>
        <span className="mission-time">{relTime(agent.lastActivity)}</span>
      </div>
      <div className="mission-copy">
        <h3>{agent.name}</h3>
        <p>
          {agent.provider}
          {agent.model ? ` · ${agent.model}` : ""} · {agent.mode} · {agent.turns} turns
          {agent.tokens.output > 0 ? ` · ${(agent.tokens.output / 1000).toFixed(1)}k out` : ""}
          {agent.originThreadId ? " · answers back to its chat room" : ""}
        </p>
        {agent.status === "working" && lastTool && (
          <div className="mission-next">
            {lastTool.tool}
            {lastTool.summary ? ` · ${lastTool.summary}` : ""}
          </div>
        )}
        {agent.status === "error" && (
          <div className="mission-blocked-note" role="alert">
            <strong>This agent hit an error.</strong> Its last output is in the
            activity below. Prompt it again to retry, or close it.
          </div>
        )}
        <details>
          <summary>Activity & prompt</summary>
          <div className="agent-feed" ref={feedRef}>
            {renderBlocks(agent.feed).map((b) => (
              <div key={b.key} className={`feed-${b.kind}`}>
                {b.text}
              </div>
            ))}
          </div>
          {err && <div className="feed-error" style={{ margin: "8px 0 0" }}>{err}</div>}
          <div className="agent-prompt">
            <input
              value={text}
              aria-label={`Prompt ${agent.name}`}
              placeholder={
                agent.status === "working" ? `${agent.name} is working…` : `Prompt ${agent.name}…`
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <button onClick={send} disabled={agent.status === "working" || !text.trim()}>
              Send
            </button>
          </div>
        </details>
      </div>
      <div className="mission-owner">
        <span
          className="owner-mark"
          style={{ ["--owner-color" as string]: OWNER_COLORS[index % OWNER_COLORS.length] }}
          aria-hidden="true"
        >
          {agent.name.slice(0, 2)}
        </span>
        <span>
          <strong>{agent.name}</strong>
          <span>live agent</span>
        </span>
        <button className="agent-close" title="Close agent" aria-label={`Close ${agent.name}`} onClick={() => onClose(agent.id)}>
          ×
        </button>
      </div>
    </article>
  );
}

export default function Canvas() {
  const personaName = usePersonaName();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [provider, setProvider] = useState("claude");
  const [name, setName] = useState("");
  const [loopGoal, setLoopGoal] = useState("");
  const agentsRef = useRef<Agent[]>([]);
  agentsRef.current = agents;

  // Live fleet via SSE; feed events mutate the matching agent in place.
  useEffect(() => {
    const es = new EventSource("/api/agents/events");
    es.onmessage = (msg) => {
      let e: any;
      try {
        e = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (e.kind === "snapshot") {
        setAgents(e.agents);
      } else if (e.kind === "spawn") {
        setAgents((prev) => (prev.some((a) => a.id === e.agent.id) ? prev : [...prev, e.agent]));
      } else if (e.kind === "close") {
        setAgents((prev) => prev.filter((a) => a.id !== e.agent.id));
      } else if (e.kind === "update") {
        setAgents((prev) => prev.map((a) => (a.id === e.agent.id ? { ...a, ...e.agent } : a)));
      } else if (e.kind === "feed") {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === e.agentId
              ? { ...a, status: e.status, feed: [...a.feed, e.event].slice(-200), lastActivity: e.event.ts }
              : a
          )
        );
      }
    };
    return () => es.close();
  }, []);

  // Swarm pipeline workers (ops/swarm) — polled, the orchestrator is a
  // separate process so there's no SSE feed to subscribe to.
  const [swarms, setSwarms] = useState<SwarmRepo[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await fetch("/api/swarm");
        const j = await r.json();
        if (!stopped) setSwarms(j.swarms || []);
      } catch {
        /* orchestrator state unreadable — keep last snapshot */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const [spawnErr, setSpawnErr] = useState<string | null>(null);

  const spawn = useCallback(async () => {
    setSpawnErr(null);
    // Block a custom name the backend can't store (e.g. no letters at all) —
    // the picker shows the plain-language note; don't fire a doomed spawn.
    const nameValidation = validateCustomAgentName(name);
    if (!nameValidation.ok) {
      setSpawnErr(nameValidation.note ?? "That name won't work. Use letters.");
      return;
    }
    try {
      const r = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, name: name.trim() || undefined }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setSpawnErr(j.error || `spawn failed (${r.status})`);
        return;
      }
      setName("");
      // SSE spawn event adds the row.
    } catch {
      setSpawnErr("network error");
    }
  }, [provider, name]);

  // Returns null on success, or an error string to surface on the row.
  const onPrompt = useCallback(async (id: string, text: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/agents/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return j.error || `send failed (${r.status})`;
      }
      return null;
    } catch {
      return "network error";
    }
  }, []);

  const onClose = useCallback(async (id: string) => {
    try {
      await fetch(`/api/agents/${id}`, { method: "DELETE" });
    } catch {
      /* SSE close event will reconcile if it went through */
    }
  }, []);

  const startLoop = useCallback(async () => {
    const goal = loopGoal.trim();
    if (!goal) return;
    setSpawnErr(null);
    try {
      const r = await fetch("/api/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setSpawnErr(j.reason || j.error || `loop failed (${r.status})`);
        return;
      }
      setLoopGoal("");
    } catch {
      setSpawnErr("network error");
    }
  }, [loopGoal]);

  // Board math for the summary + the one loud alert (Signal Studio: the rail
  // carries the single most important blocked edge, with its recovery).
  const allWorkers = swarms.flatMap((s) => s.workers.map((w) => ({ repo: s.repo, w })));
  const ledgered = allWorkers.map(({ repo, w }) => ({ repo, w, v: workerLedger(w) }));
  const workingCount =
    agents.filter((a) => a.status === "working").length +
    ledgered.filter(({ v }) => v.tone === "working").length;
  const doneCount = ledgered.filter(({ v }) => v.tone === "done").length;
  const blocked = ledgered.filter(({ v }) => v.tone === "blocked");
  const firstBlocked = blocked[0] ?? null;
  const attentionCount = blocked.length + agents.filter((a) => a.status === "error").length;

  return (
    <div className="app vc-app">
      <NavDesk
        active="fleet"
        captureLabel="Agent fleet"
        captureTitle={
          workingCount > 0
            ? `${workingCount} run${workingCount === 1 ? "" : "s"} in motion`
            : "A quiet fleet"
        }
        captureBody={`${personaName} coordinates the handoffs and surfaces only decisions that need you.`}
        footer={`${agents.length} live agent${agents.length === 1 ? "" : "s"} · ${allWorkers.length} swarm worker${allWorkers.length === 1 ? "" : "s"}`}
      />
      <main className="canvas">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Fleet · live operations</span>
            <h1>Work in motion</h1>
            <div className="vc-header-meta">
              {workingCount > 0 ? `${workingCount} active` : "nothing running"}
              {attentionCount > 0 && (
                <span className="state-pill alert">{attentionCount} need you</span>
              )}
            </div>
          </div>
          <div className="vc-header-actions">
            <select
              aria-label="Provider for a new agent"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              style={{ minHeight: 36, borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", padding: "0 10px", fontSize: 12.5 }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <AgentNamePicker name={name} onChange={setName} onEnter={spawn} />
            <button className="vc-btn-acid" onClick={spawn}>
              ＋ Give work
            </button>
          </div>
        </header>

        {spawnErr && <div className="error-banner" role="alert">{spawnErr}</div>}

        <div className="fleet-layout">
          <div style={{ minWidth: 0 }}>
            <section className="mission-stage" aria-label="Live agents">
              <header className="stage-head">
                <div>
                  <span className="micro-label">Live workboard</span>
                  <h2>Agents</h2>
                </div>
                <div className="stage-head-meta">
                  <span>{agents.length === 0 ? "none live" : `${agents.length} live`}</span>
                </div>
              </header>
              <div className="mission-list">
                {agents.length === 0 ? (
                  <article className="mission queued">
                    <div className="mission-state">
                      <span className="state-pill queued">Idle</span>
                    </div>
                    <div className="mission-copy">
                      <h3>No agents running</h3>
                      <p>
                        Give work above, say “vidi, spawn a claude agent”, or
                        launch a swarm with /swarm in chat.
                      </p>
                    </div>
                  </article>
                ) : (
                  agents.map((a, i) => (
                    <AgentMission
                      key={a.id}
                      agent={a}
                      index={i}
                      onPrompt={onPrompt}
                      onClose={onClose}
                    />
                  ))
                )}
              </div>
            </section>

            {swarms.map((s) => {
              const merged = s.workers.filter((w) => w.status === "merged").length;
              return (
                <section className="mission-stage" aria-label={`Swarm · ${s.repo}`} key={s.repo}>
                  <header className="stage-head">
                    <div>
                      <span className="micro-label">Swarm</span>
                      <h2>{s.repo}</h2>
                    </div>
                    <div className="stage-head-meta">
                      <span>{s.workers.length} workers</span>
                      {merged > 0 && <span>{merged} merged ✓</span>}
                    </div>
                  </header>
                  <div className="mission-list">
                    {s.workers.map((w, i) => {
                      const v = workerLedger(w);
                      return (
                        <article className={`mission ${v.tone}`} key={w.branch}>
                          <div className="mission-state">
                            <span className={`state-pill ${v.tone === "blocked" ? "alert" : v.tone}`}>
                              {v.pill}
                            </span>
                            <span className="mission-time">{w.branch.replace("swarm/", "")}</span>
                          </div>
                          <div className="mission-copy">
                            <h3>{w.name || w.branch.replace("swarm/", "")}</h3>
                            <p>{w.task || w.status}</p>
                            {v.blockedNote && (
                              <div className="mission-blocked-note" role="alert">
                                <strong>{v.blockedNote.reason}</strong>{" "}
                                {v.blockedNote.recovery}
                              </div>
                            )}
                            {w.pr && (
                              <div className="mission-next">
                                <a
                                  href={`https://github.com/karoslab/${s.repo}/pull/${w.pr}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  PR #{w.pr} ↗
                                </a>
                              </div>
                            )}
                            {w.activity.length > 0 && (
                              <div className="swarm-activity">
                                {w.activity.map((line, j) => (
                                  <div key={j}>{line}</div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="mission-owner">
                            <span
                              className="owner-mark"
                              style={{ ["--owner-color" as string]: OWNER_COLORS[i % OWNER_COLORS.length] }}
                              aria-hidden="true"
                            >
                              {(w.name || w.branch.replace("swarm/", "")).slice(0, 2)}
                            </span>
                            <span>
                              <strong>{w.name || "worker"}</strong>
                              <span>swarm worker</span>
                            </span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <aside className="signal-rail" aria-label="Fleet signals">
            {firstBlocked && (
              <section className="vc-alert-card" role="alert">
                <span className="micro-label">
                  {blocked.length === 1 ? "One dependency" : `${blocked.length} need you`}
                </span>
                <h3>{firstBlocked.v.pill} · {firstBlocked.w.name || firstBlocked.w.branch.replace("swarm/", "")}</h3>
                <p>{firstBlocked.v.blockedNote?.reason}</p>
                <div className="unblock-row">
                  {firstBlocked.w.pr ? (
                    <a
                      href={`https://github.com/karoslab/${firstBlocked.repo}/pull/${firstBlocked.w.pr}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PR #{firstBlocked.w.pr}
                    </a>
                  ) : (
                    <span>{firstBlocked.v.blockedNote?.recovery}</span>
                  )}
                  <span aria-hidden="true">→</span>
                </div>
              </section>
            )}

            <section className="fleet-summary">
              <span className="micro-label">Today</span>
              <h3>
                {attentionCount > 0
                  ? "The fleet needs one decision."
                  : workingCount > 0
                    ? "A quiet, productive fleet"
                    : "All quiet"}
              </h3>
              <div className="summary-stat">
                <span>Runs in motion</span>
                <strong>{workingCount}</strong>
              </div>
              <div className="summary-stat">
                <span>Merged / complete</span>
                <strong>{doneCount}</strong>
              </div>
              <div className="summary-stat">
                <span>Waiting on you</span>
                <strong>{attentionCount}</strong>
              </div>
            </section>

            <section className="margin-panel">
              <span className="micro-label">Loop</span>
              <h2>Iterate on a goal</h2>
              <div className="agent-prompt" style={{ padding: "10px 0 0", borderTop: 0 }}>
                <input
                  value={loopGoal}
                  placeholder="loop goal…"
                  aria-label="Loop goal"
                  onChange={(e) => setLoopGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") startLoop();
                  }}
                />
                <button onClick={startLoop} title="Iterate until done (Sonnet, capped)">
                  ↻ Loop
                </button>
              </div>
            </section>

            <div className="fleet-footer">runs on your subscription, no API keys</div>
          </aside>
        </div>
        <BottomNav active="fleet" />
      </main>
    </div>
  );
}
