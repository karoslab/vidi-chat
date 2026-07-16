"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavDesk, BottomNav } from "../AppNav";
import WorkingGlow from "@/components/WorkingGlow";
import { usePersonaName } from "@/components/usePersonaName";
import type { JourneyState, StepState } from "@/lib/journey/types";
import { askVidiPrompt, statusLabel, stepHref } from "@/lib/journey/ui";

/**
 * SetupHealth — the "Is everything connected?" screen.
 *
 * One live row per step: a green tick when it verified, a red cross with a
 * plain-language reason when it failed, a grey dash when it is waiting on an
 * earlier step. A single "Pick up where things broke" card deep-links to the
 * first failing step. The position comes straight from GET /api/journey, which
 * recomputes it every call, so this screen can never point somewhere stale.
 */

function StatusIcon({ status }: { status: StepState["status"] }) {
  if (status === "verified") {
    return (
      <svg className="vch-icon vch-ok" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14" />
        <path d="M7.5 12.4l3 3 6-6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="vch-icon vch-bad" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.14" />
        <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="vch-icon vch-wait" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.1" />
      <path d="M8 12h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** A recent-errors row (DIAGNOSTICS + FEEDBACK loop) — plain, already scrubbed
 *  by the ledger (no chat content / paths / tokens). Also shown in Settings;
 *  duplicated here because this is where a support call looks first. */
interface RecentDiagEntry {
  ts: number;
  category: string;
  message: string;
}

export default function SetupHealth() {
  // Live persona name: a customized install says "Anna", not the brand.
  const ASSISTANT_NAME = usePersonaName();
  const router = useRouter();
  const [state, setState] = useState<JourneyState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rechecking, setRechecking] = useState<string | null>(null);
  // Row that just finished a re-check — flashed briefly so the result lands.
  const [flashed, setFlashed] = useState<string | null>(null);
  const [recentErrors, setRecentErrors] = useState<RecentDiagEntry[]>([]);

  const load = useCallback(() => {
    fetch("/api/journey")
      .then((r) => r.json())
      .then((j) => setState(j as JourneyState))
      .catch(() => setState(null))
      .finally(() => setLoaded(true));
    fetch("/api/diag/recent")
      .then((r) => r.json())
      .then((j) => setRecentErrors(Array.isArray(j.entries) ? j.entries : []))
      .catch(() => {
        /* the recent-errors list is a gentle extra — its failure never blocks this screen */
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function recheck(stepId: string) {
    setRechecking(stepId);
    const started = Date.now();
    try {
      await fetch("/api/journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId, action: "recheck" }),
      });
      load(); // full refresh so ordering (and any newly unblocked step) updates
    } catch {
      /* leave the row as-is; the customer can try again */
    } finally {
      // The verify itself often finishes in milliseconds, which read as "the
      // button does nothing". Hold the checking state long enough to SEE,
      // then flash the row so the (possibly unchanged) verdict registers.
      const holdMs = Math.max(0, 700 - (Date.now() - started));
      setTimeout(() => {
        setRechecking(null);
        setFlashed(stepId);
        setTimeout(() => setFlashed(null), 900);
      }, holdMs);
    }
  }

  function askVidiAbout(step: StepState) {
    try {
      sessionStorage.setItem("vidi:ask-prefill", askVidiPrompt(step));
    } catch {
      /* storage off — chat still opens */
    }
    router.push("/?ask=1");
  }

  const steps = state?.steps ?? [];
  const broken = steps.find((s) => s.id === state?.currentStepId) ?? null;
  const total = steps.length;

  return (
    <div className="app vc-app">
      <NavDesk active="setup" footer="Setup health" />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Setup · is everything connected</span>
            <h1>Is everything connected?</h1>
          </div>
          <div className="vc-header-actions">
            <button className="vc-btn-quiet" onClick={load}>
              Refresh
            </button>
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>

        {!loaded ? (
          <div className="vch-loading vch-loading-page" role="status">
            <WorkingGlow lines={["Checking everything now…"]} />
            <span className="vch-loading-sub">
              Each part gets a real check. This takes a few seconds.
            </span>
          </div>
        ) : (
        <article className="daily-page vch-page" aria-label="Setup health">
          {(
            <>
              {state?.complete ? (
                <div className="vch-allgood" role="status">
                  <strong>Everything is connected.</strong> {ASSISTANT_NAME}{" "}is fully set up and
                  ready. You are all done here.
                </div>
              ) : broken ? (
                <div className="vch-pickup" role="alert">
                  <span className="micro-label">Pick up where things broke</span>
                  <h3>{broken.title}</h3>
                  {broken.reason && <p className="vch-pickup-reason">{broken.reason}</p>}
                  <div className="vch-pickup-actions">
                    <Link className="vc-btn-solid" href={stepHref(broken.fixStepId ?? broken.id)}>
                      Fix this now
                    </Link>
                    <button className="vc-btn-quiet" onClick={() => askVidiAbout(broken)}>
                      Ask {ASSISTANT_NAME}
                    </button>
                  </div>
                </div>
              ) : null}

              <section className="vch-rows" aria-label="Connection checks">
                {steps.map((s) => (
                  <div
                    className={`vch-row vch-${s.status} ${flashed === s.id ? "vch-flash" : ""}`}
                    key={s.id}
                  >
                    {rechecking === s.id ? (
                      <span className="vch-spin" aria-hidden="true" />
                    ) : (
                      <StatusIcon status={s.status} />
                    )}
                    <div className="vch-row-main">
                      <div className="vch-row-head">
                        <strong>{s.title}</strong>
                        <span className="vch-row-status">{statusLabel(s.status)}</span>
                      </div>
                      {s.status === "failed" && s.reason && (
                        <p className="vch-row-reason">{s.reason}</p>
                      )}
                      {s.status === "pending" && (
                        <p className="vch-row-reason vch-muted">
                          {ASSISTANT_NAME}{" "}checks this once the step above is working.
                        </p>
                      )}
                      {s.status === "skipped" && (
                        <p className="vch-row-reason vch-muted">
                          {s.reason ?? "Optional. You can set this up any time, or leave it."}
                        </p>
                      )}
                      {s.status === "verified" && s.note && (
                        <p className="vch-row-reason vch-muted">{s.note}</p>
                      )}
                    </div>
                    <div className="vch-row-side">
                      {s.checkedAt && <span className="vch-time">Checked {fmtTime(s.checkedAt)}</span>}
                      {/* Optional-not-set-up rows get a real way IN, not just a
                          re-check (2026-07-12 demo feedback). */}
                      {s.status === "skipped" && (
                        <Link className="vc-btn-solid vch-setup-link" href={stepHref(s.fixStepId ?? s.id)}>
                          Set it up
                        </Link>
                      )}
                      {s.status !== "pending" && (
                        <button
                          className="vc-btn-quiet vch-recheck"
                          onClick={() => recheck(s.id)}
                          disabled={rechecking === s.id}
                        >
                          {rechecking === s.id ? (
                            <>
                              <span className="vch-spin" aria-hidden="true" />
                              Checking…
                            </>
                          ) : (
                            "Check again"
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>

              <section className="vch-recent-errors" aria-label="Recent errors">
                <div className="micro-label">Recent errors</div>
                {recentErrors.length === 0 ? (
                  <p className="vch-row-reason vch-muted">Nothing has gone wrong recently.</p>
                ) : (
                  <ul className="vch-recent-list">
                    {recentErrors.map((entry, i) => (
                      <li key={i} className="vch-recent-item">
                        <span className="vch-time">{fmtTime(new Date(entry.ts).toISOString())}</span>
                        <span className="vch-row-reason">{entry.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="vcj-note">
                <strong>How this works.</strong> {ASSISTANT_NAME}{" "}checks each part for real, every
                time you open this screen. Green means it is working, red means it needs you, and a
                dash means it is waiting on the step above. You never have to remember where you left
                off.
              </div>
            </>
          )}
        </article>
        )}
        <BottomNav active="setup" />
      </main>
    </div>
  );
}
