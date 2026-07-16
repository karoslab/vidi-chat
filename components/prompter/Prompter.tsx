"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { NavDesk, BottomNav } from "@/components/AppNav";
import WorkingGlow from "@/components/WorkingGlow";
import { useRouter, useSearchParams } from "next/navigation";
import type { PrompterAnswer } from "@/lib/prompter";
import PrompterFlow from "./PrompterFlow";
import BriefView from "./BriefView";

/**
 * Prompter — the top-level surface that turns a customer's scattered ideas into
 * a readable Build Brief. Three phases: pick up an existing plan or start a new
 * one (home), answer the guided questions (flow), then read and shape the plan
 * (brief). Copy speaks the customer's language throughout.
 */

interface BriefSummary {
  slug: string;
  title: string;
  version: number;
  updatedAt: number;
}

type Phase = { name: "home" } | { name: "flow" } | { name: "brief"; slug: string };

const jsonPost = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export default function Prompter() {
  const [phase, setPhase] = useState<Phase>({ name: "home" });
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [synthesizing, setSynthesizing] = useState(false);

  async function loadBriefs() {
    const res = await fetch("/api/prompter").then((r) => r.json());
    setBriefs(res.briefs || []);
  }

  useEffect(() => {
    void loadBriefs();
  }, []);

  const [rawDump, setRawDump] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const homeParam = searchParams?.get("home") ?? null;

  // Rail "Plan" while already here returns to the landing; a plan-in-progress
  // asks before discarding (2026-07-12 customer ask).
  useEffect(() => {
    if (!homeParam) return;
    if (phase.name !== "home") {
      const midWalk = phase.name === "flow";
      const ok = !midWalk || window.confirm("Go back to the Plan page? The answers you typed in this walk will be discarded.");
      if (ok) setPhase({ name: "home" });
    }
    router.replace("/prompter");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeParam]);

  /** One-shot path: the whole idea in one box, no question walk. */
  async function onRawDump() {
    if (!rawDump.trim()) return;
    setSynthesizing(true);
    try {
      const res = await jsonPost("/api/prompter/synthesize", { rawDump: rawDump.trim() });
      if (res.slug) {
        setRawDump("");
        await loadBriefs();
        setPhase({ name: "brief", slug: res.slug });
      }
    } finally {
      setSynthesizing(false);
    }
  }

  async function deletePlan(slug: string, title: string) {
    if (!window.confirm(`Remove the plan "${title}"? This cannot be undone.`)) return;
    try {
      await fetch("/api/prompter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", slug }),
      });
      await loadBriefs();
    } catch {
      /* leave the list as-is; the plan is still there */
    }
  }

  async function onReady(answers: PrompterAnswer[]) {
    setSynthesizing(true);
    try {
      const res = await jsonPost("/api/prompter/synthesize", { answers });
      if (res.slug) {
        await loadBriefs();
        setPhase({ name: "brief", slug: res.slug });
      }
    } finally {
      setSynthesizing(false);
    }
  }

  return (
    <div className="app vc-app">
      <NavDesk active="plan" footer={`${briefs.length} plan${briefs.length === 1 ? "" : "s"}`} />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Plan an idea</span>
            <h1>Let us plan your idea</h1>
          </div>
          <div className="vc-header-actions">
            {phase.name !== "home" && (
              <button
                type="button"
                className="vc-btn-quiet"
                style={{ cursor: "pointer" }}
                onClick={() => setPhase({ name: "home" })}
              >
                All plans
              </button>
            )}
            <Link className="vc-btn-quiet" href="/">
              Back to Home
            </Link>
          </div>
        </header>

        <div className="vc-scroll" style={{ padding: "24px 16px 80px" }}>
          {synthesizing ? (
            <WorkingGlow
              lines={[
                "Reading everything you told me…",
                "Sketching the pages…",
                "Choosing the simplest way to build it…",
                "Writing it up in plain words…",
                "Almost there…",
              ]}
            />
          ) : phase.name === "home" ? (
            <div style={{ maxWidth: 720, margin: "0 auto" }}>
              <p style={{ opacity: 0.8 }}>
                Tell us what you want to make. We will ask a few plain questions,
                then write it up so anyone can follow it and build it.
              </p>
              <button
                type="button"
                className="vc-btn-solid"
                onClick={() => setPhase({ name: "flow" })}
                style={{ marginTop: 16 }}
              >
                Start a new plan
              </button>

              <div className="prompter-dump">
                <p className="micro-label">In a hurry? Skip the questions</p>
                <p className="prompter-dump-help">
                  Throw the whole idea in here, messy is fine, and get a plan in
                  one go.
                </p>
                <textarea
                  className="onb-input prompter-dump-box"
                  rows={4}
                  value={rawDump}
                  placeholder="Example: a page for my dog walking side business, people pick a time and book me, keep it friendly and simple..."
                  onChange={(e) => setRawDump(e.target.value)}
                />
                <button
                  type="button"
                  className="vc-btn-solid"
                  disabled={!rawDump.trim() || synthesizing}
                  onClick={onRawDump}
                >
                  Plan it in one go
                </button>
              </div>

              {briefs.length > 0 && (
                <div style={{ marginTop: 36 }}>
                  <p className="micro-label">Plans you started</p>
                  <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                    {briefs.map((b) => (
                      <li key={b.slug} className="prompter-plan-row">
                        <button
                          type="button"
                          className="prompter-plan-open"
                          onClick={() => setPhase({ name: "brief", slug: b.slug })}
                        >
                          <strong>{b.title}</strong>
                          <span style={{ opacity: 0.6, marginLeft: 8 }}>version {b.version}</span>
                        </button>
                        <button
                          type="button"
                          className="prompter-plan-delete"
                          title="Remove this plan"
                          aria-label={`Remove ${b.title}`}
                          onClick={() => deletePlan(b.slug, b.title)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : phase.name === "flow" ? (
            <PrompterFlow onReady={onReady} onCancel={() => setPhase({ name: "home" })} />
          ) : (
            <BriefView slug={phase.slug} />
          )}
        </div>
      </main>
      <BottomNav active="plan" />
    </div>
  );
}
