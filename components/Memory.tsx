"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NavDesk, BottomNav } from "./AppNav";
import { usePersonaName } from "@/components/usePersonaName";

/**
 * Memory — the ownership page. It shows everything Vidi has been asked to
 * remember and lets you correct it, forget single items, export the whole set,
 * or reset it. This adds NO new memory; it is a set of controls over the notes
 * Vidi already keeps. Copy is deliberately plain: no jargon, no dashes.
 */

interface RememberedNote {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  source: string;
}

const RESET_PHRASE = "delete my memory";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export default function Memory() {
  // Live persona name: a customized install says "Anna", not the brand.
  const ASSISTANT_NAME = usePersonaName();
  const [notes, setNotes] = useState<RememberedNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per item UI state.
  const [confirmingForget, setConfirmingForget] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Reset section.
  const [resetPhrase, setResetPhrase] = useState("");
  const [resetDone, setResetDone] = useState(false);

  const load = useCallback(() => {
    fetch("/api/memory")
      .then((r) => r.json())
      .then((j) => setNotes(j.notes || []))
      .catch(() => setNotes([]))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function forget(id: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not forget that.");
      setConfirmingForget(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveCorrection(id: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch("/api/memory/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, body: draft }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save that.");
      setEditingId(null);
      setDraft("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportMemory() {
    setError(null);
    try {
      // Fetch via JS so the session token (added by the app fetch shim) is sent;
      // a raw anchor download would omit it and the route would reject it.
      const r = await fetch("/api/memory/export");
      if (!r.ok) throw new Error("Could not export your memory.");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "vidi-memory-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reset() {
    setBusy("reset");
    setError(null);
    try {
      const r = await fetch("/api/memory/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmPhrase: resetPhrase }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not reset.");
      setResetPhrase("");
      setResetDone(true);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app vc-app">
      <NavDesk
        active="memory"
        captureLabel={`What ${ASSISTANT_NAME} keeps`}
        captureTitle="Your memory, your call"
        captureBody="See it, fix it, forget it, or take it with you. Nothing here is hidden."
        footer={`${notes.length} remembered item${notes.length === 1 ? "" : "s"}`}
      />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Memory · what {ASSISTANT_NAME}{" "}remembers</span>
            <h1>Everything you asked {ASSISTANT_NAME}{" "}to keep</h1>
          </div>
          <div className="vc-header-actions">
            <button className="vc-btn-quiet" onClick={exportMemory}>
              Export
            </button>
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>

        <article className="daily-page vcm-page" aria-label="Remembered items">
          {error && (
            <p className="vcm-error" role="alert">
              {error}
            </p>
          )}

          {!loaded ? (
            <div className="vcj-empty">Reading what {ASSISTANT_NAME}{" "}remembers.</div>
          ) : notes.length === 0 ? (
            <div className="vcj-empty">
              {ASSISTANT_NAME}{" "}hasn&apos;t been asked to remember anything yet. Say or type:
              remember that...
            </div>
          ) : (
            <section className="vcj-section" aria-label="Remembered items">
              <span className="micro-label">You can fix or forget any of these</span>
              <h3>Remembered items</h3>
              {notes.map((n) => (
                <div className="ledger-item vcm-item" key={n.id}>
                  <strong>{n.title}</strong>
                  <span className="ledger-meta">
                    <span>{fmtDate(n.createdAt)}</span>
                    <span className="vcm-source">Source: {n.source}</span>
                  </span>

                  {editingId === n.id ? (
                    <div className="vcm-correct">
                      <label htmlFor={`edit-${n.id}`}>Correct what {ASSISTANT_NAME}{" "}remembers</label>
                      <textarea
                        id={`edit-${n.id}`}
                        className="vcm-textarea"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={4}
                      />
                      <div className="vcm-actions">
                        <button
                          className="vc-btn-solid"
                          disabled={busy === n.id || !draft.trim()}
                          onClick={() => saveCorrection(n.id)}
                        >
                          {busy === n.id ? "Saving." : "Save correction"}
                        </button>
                        <button
                          className="vc-btn-quiet"
                          onClick={() => {
                            setEditingId(null);
                            setDraft("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : confirmingForget === n.id ? (
                    <div className="vcm-actions">
                      <span className="vcm-confirm-copy">
                        Forget this? {ASSISTANT_NAME}{" "}will no longer recall it.
                      </span>
                      <button
                        className="vc-btn-solid"
                        disabled={busy === n.id}
                        onClick={() => forget(n.id)}
                      >
                        {busy === n.id ? "Forgetting." : "Yes, forget it"}
                      </button>
                      <button className="vc-btn-quiet" onClick={() => setConfirmingForget(null)}>
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <div className="vcm-actions">
                      <button
                        className="vc-btn-quiet"
                        onClick={() => {
                          setEditingId(n.id);
                          setDraft(n.body);
                          setConfirmingForget(null);
                        }}
                      >
                        Correct
                      </button>
                      <button
                        className="vc-btn-quiet"
                        onClick={() => {
                          setConfirmingForget(n.id);
                          setEditingId(null);
                        }}
                      >
                        Forget
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="vcm-reset" aria-label="Reset all memory">
            <span className="micro-label">Start over</span>
            <h3>Reset everything {ASSISTANT_NAME}{" "}remembers</h3>
            <p className="vcm-reset-copy">
              This deletes everything {ASSISTANT_NAME}{" "}remembers. Your conversations are not deleted. A copy
              is kept in the app&apos;s trash folder on this Mac.
            </p>
            {resetDone ? (
              <p className="vcm-reset-done">
                Done. {ASSISTANT_NAME}&apos;s memory has been cleared and a copy was kept in the trash folder.
              </p>
            ) : (
              <>
                <label htmlFor="reset-phrase">
                  Type <strong>{RESET_PHRASE}</strong> to confirm
                </label>
                <input
                  id="reset-phrase"
                  className="vcm-input"
                  value={resetPhrase}
                  placeholder={RESET_PHRASE}
                  onChange={(e) => setResetPhrase(e.target.value)}
                  autoComplete="off"
                />
                <button
                  className="vc-btn-solid vcm-danger"
                  disabled={busy === "reset" || resetPhrase !== RESET_PHRASE}
                  onClick={reset}
                >
                  {busy === "reset" ? "Resetting." : "Reset my memory"}
                </button>
              </>
            )}
          </section>

          <div className="vcj-note">
            <strong>You are in control.</strong> These are the things you asked {ASSISTANT_NAME}{" "}
            to remember. Forgetting removes the note and rebuilds the search index without it.
            Your conversations live separately and are never touched here.
          </div>
        </article>
        <BottomNav active="memory" />
      </main>
    </div>
  );
}
