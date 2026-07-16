"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NavDesk, BottomNav } from "../AppNav";
import { ASSISTANT_NAME } from "@/lib/assistant-identity";
import type { JourneyState, StepState } from "@/lib/journey/types";
import WorkingGlow from "../WorkingGlow";
import { StepFrame } from "./StepFrame";
import MemorySeed from "./steps/MemorySeed";
import MemoryBringStuff from "./steps/MemoryBringStuff";
import ClaudeStep from "./steps/ClaudeStep";
import GithubStep from "./steps/GithubStep";
import DiscordSetup from "./steps/DiscordSetup";
import PhoneAccess from "./steps/PhoneAccess";

/**
 * The generic step screen behind /setup/step/[id]. It pulls the live journey,
 * finds the step by id, works out its position, and renders it in the shared
 * StepFrame. Steps with a richer interaction supply their screen through
 * RICH_ACTIONS below (dropped into StepFrame's `action` slot, wired to re-verify
 * on done). Everything else — the three foundation steps, memory-wiki, and the
 * approval desk — is a link-and-recheck step and renders from its primaryAction.
 */

/**
 * Rich per-step screens, keyed by step id. Each returns the interactive control
 * for StepFrame's `action` slot; `onDone` re-verifies the step and refreshes the
 * journey (StepFrame's onRecheck). Ids not listed here fall back to the step's
 * primaryAction link. Mirrors each component's INTEGRATION note.
 */
const RICH_ACTIONS: Record<string, (onDone: () => void) => ReactNode> = {
  "claude-connected": (onDone) => <ClaudeStep onDone={onDone} />,
  "memory-interview": (onDone) => <MemorySeed onDone={onDone} />,
  "memory-bring-stuff": (onDone) => <MemoryBringStuff onDone={onDone} />,
  "github-connect": (onDone) => <GithubStep onDone={onDone} onSkip={onDone} />,
  "discord-mirror": (onDone) => <DiscordSetup onConnected={onDone} onSkip={onDone} />,
  "phone-access": (onDone) => <PhoneAccess onDone={onDone} />,
};
export default function StepScreen({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<JourneyState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(() => {
    fetch("/api/journey")
      .then((r) => r.json())
      .then((j) => setState(j as JourneyState))
      .catch(() => setState(null))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function recheck() {
    setRechecking(true);
    try {
      await fetch("/api/journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: id, action: "recheck" }),
      });
      load();
    } catch {
      /* leave as-is */
    } finally {
      setRechecking(false);
    }
  }

  /** Rich steps' Done/Skip: re-verify this step, then land back on the setup
   *  board (2026-07-12 demo feedback: Done stranded people on the step page). */
  async function completeAndReturn() {
    try {
      await fetch("/api/journey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: id, action: "recheck" }),
      });
    } catch {
      /* the board recomputes everything on load anyway */
    }
    router.push("/setup");
  }

  const steps = state?.steps ?? [];
  const idx = steps.findIndex((s) => s.id === id);
  const step: StepState | null = idx >= 0 ? steps[idx] : null;

  return (
    <div className="app vc-app">
      <NavDesk active="setup" footer="Setup" />
      <main className="vc-shell">
        <header className="vc-header">
          <div className="vc-header-title">
            <span className="micro-label">Setup step</span>
            <h1>{step?.title ?? "Setup step"}</h1>
          </div>
          <div className="vc-header-actions">
            <Link className="vc-btn-quiet" href="/setup">
              All checks
            </Link>
          </div>
        </header>

        <article className="daily-page vcstep-page" aria-label="Setup step">
          {!loaded ? (
            <div className="vcj-empty">
              <WorkingGlow lines={["Checking this step now."]} />
            </div>
          ) : step ? (
            <StepFrame
              step={step}
              index={idx + 1}
              total={steps.length}
              onRecheck={recheck}
              rechecking={rechecking}
              action={RICH_ACTIONS[id]?.(completeAndReturn)}
            />
          ) : (
            <div className="vcj-empty">
              That setup step was not found. Tap All checks to see where things stand.
            </div>
          )}
        </article>
        <BottomNav active="setup" />
      </main>
    </div>
  );
}
