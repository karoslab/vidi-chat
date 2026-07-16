"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NavDesk, BottomNav } from "../AppNav";
import { usePersonaName } from "@/components/usePersonaName";
import { DiscordSetup } from "../journey/steps/DiscordSetup";

/**
 * Stage 5 — "Your approval desk". The in-app source of truth for making Vidi's
 * work live. Each card is a piece of work waiting for the customer's OK, in
 * plain language, with three moves: make it live, see it first, or ask for
 * changes. Empty state: "Nothing waiting for you."
 *
 * Copy rule: customer words. Never "PR" or "merge" in the UI.
 */

interface WorkCard {
  ref: string;
  repo: string;
  number: number;
  title: string;
  summary: string;
  nothingExistingChanged: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  branch: string;
}

interface DeskData {
  cards: WorkCard[];
  discord: { configured: boolean; connected: boolean };
}

export default function ApprovalDesk() {
  // Live persona name: a customized install says "Anna", not the brand.
  const ASSISTANT_NAME = usePersonaName();
  const [data, setData] = useState<DeskData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changesFor, setChangesFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [showDiscord, setShowDiscord] = useState(false);

  const load = useCallback(() => {
    fetch("/api/approvals")
      .then((r) => r.json())
      .then((j: DeskData) => setData({ cards: j.cards || [], discord: j.discord || { configured: false, connected: false } }))
      .catch(() => setData({ cards: [], discord: { configured: false, connected: false } }))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(card: WorkCard) {
    setBusyRef(card.ref);
    setNotice(null);
    try {
      const res = await fetch("/api/approvals/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: card.ref }),
      });
      const j = await res.json().catch(() => ({}));
      setNotice(j.message || (res.ok ? "Done. It's live now." : "That couldn't go live yet."));
      if (res.ok) load();
    } catch {
      setNotice("Something went wrong. Try again.");
    } finally {
      setBusyRef(null);
    }
  }

  async function sendChanges(card: WorkCard) {
    if (!note.trim()) return;
    setBusyRef(card.ref);
    setNotice(null);
    try {
      const res = await fetch("/api/approvals/request-changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: card.ref, note }),
      });
      const j = await res.json().catch(() => ({}));
      setNotice(j.message || (res.ok ? `Sent back to ${ASSISTANT_NAME} with your note.` : "Couldn't send that back."));
      if (res.ok) {
        setChangesFor(null);
        setNote("");
      }
    } catch {
      setNotice("Something went wrong. Try again.");
    } finally {
      setBusyRef(null);
    }
  }

  const cards = data?.cards ?? [];
  const discordConnected = data?.discord.connected ?? false;

  return (
    <div className="app vc-app">
      {/* "desk" isn't a shared NavDest (same convention as Plan/Setup — a
          self-contained rail link, not a highlighted primary item); "rooms"
          matches Prompter's fallback for the same reason. */}
      <NavDesk active="approvals" footer={`${cards.length} waiting`} />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Your approval desk</span>
            <h1>Work waiting for your OK</h1>
          </div>
          <div className="vc-header-actions">
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>

        {notice && (
          <div className="vc-desk-notice" role="status">
            {notice}
          </div>
        )}

        <div className="vc-desk-layout">
          <section className="vc-desk-cards" aria-label="Work waiting for your OK">
            {!loaded ? (
              <div className="vc-desk-empty">Looking for anything waiting…</div>
            ) : cards.length === 0 ? (
              <div className="vc-desk-empty">
                <h2>Nothing waiting for you.</h2>
                <p>
                  When {ASSISTANT_NAME}{" "}finishes something that needs your OK,
                  it shows up here first. You decide what goes live.
                </p>
              </div>
            ) : (
              cards.map((card) => {
                const busy = busyRef === card.ref;
                return (
                  <article className="vc-work-card" key={card.ref}>
                    <div className="vc-work-body">
                      <h2>{card.title}</h2>
                      <p className="vc-work-summary">{card.summary}</p>
                      {card.nothingExistingChanged && (
                        <p className="vc-work-tag">Nothing you already had was changed.</p>
                      )}
                    </div>

                    <div className="vc-work-actions">
                      <button
                        className="vc-btn-solid"
                        onClick={() => approve(card)}
                        disabled={busy}
                      >
                        {busy ? "Making it live…" : "Approve and make it live"}
                      </button>
                      <a
                        className="vc-btn-quiet"
                        href={card.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        See it first
                      </a>
                      <button
                        className="vc-btn-quiet"
                        onClick={() => {
                          setChangesFor(changesFor === card.ref ? null : card.ref);
                          setNote("");
                        }}
                        disabled={busy}
                      >
                        Ask for changes
                      </button>
                    </div>

                    {changesFor === card.ref && (
                      <div className="vc-work-changes">
                        <label htmlFor={`note-${card.ref}`}>
                          What should {ASSISTANT_NAME}{" "}change?
                        </label>
                        <textarea
                          id={`note-${card.ref}`}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder={`Tell ${ASSISTANT_NAME} in your own words…`}
                          rows={3}
                        />
                        <div className="vc-work-changes-actions">
                          <button
                            className="vc-btn-solid"
                            onClick={() => sendChanges(card)}
                            disabled={busy || !note.trim()}
                          >
                            Send to {ASSISTANT_NAME}
                          </button>
                          <button
                            className="vc-btn-quiet"
                            onClick={() => setChangesFor(null)}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </section>

          <aside className="vc-desk-side" aria-label="Phone notifications">
            <div className="vc-desk-discord">
              <span className="micro-label">Phone pings</span>
              {discordConnected ? (
                <p>Discord is connected. You'll get a message when work is ready.</p>
              ) : (
                <>
                  <p>
                    Want a ping on your phone when work is ready? Connect a free
                    Discord channel. It's optional.
                  </p>
                  {showDiscord ? (
                    <DiscordSetup
                      onConnected={() => {
                        setShowDiscord(false);
                        load();
                      }}
                      onSkip={() => setShowDiscord(false)}
                    />
                  ) : (
                    <button className="vc-btn-quiet" onClick={() => setShowDiscord(true)}>
                      Set up phone pings
                    </button>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>
        <BottomNav active="approvals" />
      </main>
    </div>
  );
}
