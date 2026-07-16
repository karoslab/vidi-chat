"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BRIEF_SECTIONS,
  renderSectionValue,
  type Brief,
  type BriefSectionKey,
  type SectionChange,
} from "@/lib/prompter-brief";

/**
 * BriefView — the readable Build Brief. The customer sees their plan in plain
 * words, edits any section inline (each edit re-saves and appends history),
 * hits "Build this" to hand the plan to Vidi, or "I have more ideas" to fold in
 * new scattered thoughts as a before/after amendment they approve.
 */

interface Props {
  slug: string;
}

const jsonPost = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export default function BriefView({ slug }: Props) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [version, setVersion] = useState(1);
  const [editing, setEditing] = useState<BriefSectionKey | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/prompter/brief?slug=${encodeURIComponent(slug)}`).then((r) =>
      r.json()
    );
    if (res.brief) {
      setBrief(res.brief as Brief);
      setVersion(res.version);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSection(key: BriefSectionKey) {
    setBusy(true);
    try {
      const res = await jsonPost("/api/prompter/brief", { slug, section: key, value: draft });
      if (res.brief) {
        setBrief(res.brief as Brief);
        setVersion(res.version);
      }
    } finally {
      setBusy(false);
      setEditing(null);
    }
  }

  if (!brief) {
    return <p style={{ opacity: 0.7, maxWidth: 720, margin: "0 auto" }}>Opening your plan…</p>;
  }

  return (
    <div className="vcp-brief" style={{ maxWidth: 720, margin: "0 auto" }}>
      <p className="micro-label">Your plan · version {version}</p>
      <h1 style={{ marginTop: 4 }}>{brief.title}</h1>
      <p style={{ opacity: 0.75, marginTop: 4 }}>
        This is your idea written up so anyone can follow it. Change anything that
        is not quite right, then let us build it.
      </p>

      <div style={{ marginTop: 24 }}>
        {BRIEF_SECTIONS.filter((s) => s.key !== "title").map((spec) => {
          const value = renderSectionValue(brief, spec.key);
          const isEditing = editing === spec.key;
          const items = spec.kind === "list" ? value.split("\n").filter(Boolean) : [];
          return (
            <section
              key={spec.key}
              style={{ padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,0.08)" }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <h3 style={{ margin: 0, flex: 1 }}>{spec.label}</h3>
                {!isEditing && (
                  <button
                    type="button"
                    className="vc-btn-quiet"
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setEditing(spec.key);
                      setDraft(value);
                    }}
                  >
                    Change
                  </button>
                )}
              </div>

              {isEditing ? (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={spec.kind === "list" ? 5 : 3}
                    style={{
                      width: "100%",
                      padding: 10,
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.2)",
                      font: "inherit",
                    }}
                  />
                  {spec.kind === "list" && (
                    <p className="micro-label" style={{ marginTop: 4 }}>
                      One per line
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <button
                      type="button"
                      className="vc-btn"
                      style={{ cursor: "pointer" }}
                      disabled={busy}
                      onClick={() => saveSection(spec.key)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="vc-btn-quiet"
                      style={{ cursor: "pointer" }}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : spec.kind === "list" ? (
                items.length ? (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    {items.map((it, i) => (
                      <li key={i}>{it}</li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ opacity: 0.5, marginTop: 8 }}>Nothing here yet</p>
                )
              ) : (
                <p style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {value || <span style={{ opacity: 0.5 }}>Nothing here yet</span>}
                </p>
              )}
            </section>
          );
        })}
      </div>

      <BuildBar slug={slug} brief={brief} />
      <AmendPanel slug={slug} onApplied={load} />
    </div>
  );
}

/** "Build this" — hands the plan to Vidi via the ordinary chat turn path, or
 *  explains plainly when this setup can only plan. */
function BuildBar({ slug, brief }: { slug: string; brief: Brief }) {
  const [state, setState] = useState<"idle" | "checking" | "starting" | "planOnly">("idle");
  const [explanation, setExplanation] = useState("");

  async function build() {
    setState("checking");
    const res = await jsonPost("/api/prompter/build", { slug });
    if (!res.available) {
      setExplanation(res.explanation || "This setup can only plan for now.");
      setState("planOnly");
      return;
    }
    setState("starting");
    // Reuse the normal thread turn path: seed a new act-mode thread with the
    // brief as the task, then open it so the customer can watch it build.
    const chat = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: res.seed, provider: res.provider, mode: res.mode }),
    });
    let threadId: string | null = null;
    try {
      const reader = chat.body?.getReader();
      const decoder = new TextDecoder();
      // Read just enough of the SSE stream to learn the thread id; the turn
      // keeps running server-side after we navigate away.
      if (reader) {
        const { value } = await reader.read();
        const chunk = decoder.decode(value ?? new Uint8Array());
        const m = chunk.match(/"threadId":"([^"]+)"/);
        if (m) threadId = m[1];
        void reader.cancel();
      }
    } catch {
      /* the turn still runs; fall back to Home */
    }
    window.location.href = threadId ? `/?room=${threadId}` : "/";
  }

  return (
    <div style={{ marginTop: 28 }}>
      <button
        type="button"
        className="vc-btn"
        onClick={build}
        disabled={state === "checking" || state === "starting"}
        style={{ padding: "12px 24px", borderRadius: 12, cursor: "pointer", fontWeight: 600 }}
        title={`Build ${brief.title}`}
      >
        {state === "starting" ? "Starting…" : "Build this"}
      </button>
      {state === "planOnly" && (
        <p style={{ marginTop: 12, opacity: 0.85 }}>
          {explanation} You can keep shaping the plan above whenever you like.
        </p>
      )}
    </div>
  );
}

/** "I have more ideas" — a fresh dump mapped onto the brief as a before/after
 *  amendment the customer approves. */
function AmendPanel({ slug, onApplied }: { slug: string; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{
    changes: SectionChange[];
    proposedBrief: Brief;
    toVersion: number;
  } | null>(null);

  async function propose() {
    setBusy(true);
    try {
      const res = await jsonPost("/api/prompter/amend", { slug, ideas });
      setProposal(res);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!proposal) return;
    setBusy(true);
    try {
      await jsonPost("/api/prompter/amend", { slug, apply: true, brief: proposal.proposedBrief });
      setProposal(null);
      setIdeas("");
      setOpen(false);
      onApplied();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.12)" }}>
      {!open ? (
        <button
          type="button"
          className="vc-btn-quiet"
          style={{ cursor: "pointer" }}
          onClick={() => setOpen(true)}
        >
          I have more ideas
        </button>
      ) : (
        <div>
          <p className="micro-label">Tell us the new ideas</p>
          <textarea
            value={ideas}
            onChange={(e) => setIdeas(e.target.value)}
            rows={4}
            placeholder="Throw down whatever came to mind…"
            style={{
              width: "100%",
              marginTop: 6,
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.2)",
              font: "inherit",
            }}
          />
          {!proposal ? (
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                type="button"
                className="vc-btn"
                style={{ cursor: "pointer" }}
                disabled={busy || !ideas.trim()}
                onClick={propose}
              >
                {busy ? "…" : "See the changes"}
              </button>
              <button
                type="button"
                className="vc-btn-quiet"
                style={{ cursor: "pointer" }}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              {proposal.changes.length === 0 ? (
                <p style={{ opacity: 0.8 }}>
                  Nothing in your plan needs to change for that. It already fits.
                </p>
              ) : (
                <>
                  <p className="micro-label">Here is what would change</p>
                  {proposal.changes.map((c) => (
                    <div
                      key={c.key}
                      style={{
                        margin: "10px 0",
                        padding: 12,
                        borderRadius: 12,
                        background: "rgba(0,0,0,0.03)",
                      }}
                    >
                      <strong>{c.label}</strong>
                      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                        <div>
                          <span className="micro-label">Now</span>
                          <p style={{ whiteSpace: "pre-wrap", opacity: 0.65, margin: "2px 0 0" }}>
                            {c.before || "(nothing yet)"}
                          </p>
                        </div>
                        <div>
                          <span className="micro-label">After</span>
                          <p style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>
                            {c.after || "(nothing)"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  className="vc-btn"
                  style={{ cursor: "pointer" }}
                  disabled={busy || proposal.changes.length === 0}
                  onClick={approve}
                >
                  Use these changes
                </button>
                <button
                  type="button"
                  className="vc-btn-quiet"
                  style={{ cursor: "pointer" }}
                  onClick={() => setProposal(null)}
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
