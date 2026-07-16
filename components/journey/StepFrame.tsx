"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { usePersonaName } from "@/components/usePersonaName";
import type { StepState } from "@/lib/journey/types";
import { askVidiPrompt, stepEyebrow } from "@/lib/journey/ui";

/**
 * StepFrame — the shared anatomy of every Vidi Journey step screen.
 *
 * Stage modules render <StepFrame step={...} index={n} total={m} ...>, dropping
 * their ONE interactive control into the `action` slot (or relying on the step's
 * primaryAction link). Everything else — the eyebrow, title, one-sentence why,
 * the "What you should see" panel, the "That did not happen" branch, and the
 * "Ask Vidi" button — is provided here so every step reads and behaves the same.
 *
 * Copy rule: plain, grounded, no dashes in visible strings, and never the words
 * repo / CLI / token. Frost styling via the shared vc- token classes.
 */
export function StepFrame({
  step,
  index,
  total,
  action,
  outcome,
  troubleshooting,
  onRecheck,
  rechecking,
}: {
  step: StepState;
  /** 1-based position of this step in the journey. */
  index: number;
  total: number;
  /** The ONE primary control for this step. Falls back to the step's
   *  primaryAction link when omitted. */
  action?: ReactNode;
  /** Override the "What you should see" copy (defaults to step.outcome). */
  outcome?: ReactNode;
  /** The "That did not happen" branch content (steps supply their own fixes). */
  troubleshooting?: ReactNode;
  /** Run the mechanical re-check for this step. */
  onRecheck?: () => void;
  rechecking?: boolean;
}) {
  const router = useRouter();
  // Live persona name: a customized install says "Anna", not the brand.
  const ASSISTANT_NAME = usePersonaName();
  const [branchOpen, setBranchOpen] = useState(step.status === "failed");

  function askVidi() {
    const prompt = askVidiPrompt(step);
    try {
      sessionStorage.setItem("vidi:ask-prefill", prompt);
    } catch {
      /* private mode / storage off — the chat still opens, just not prefilled */
    }
    router.push("/?ask=1");
  }

  const whatYouShouldSee = outcome ?? step.outcome ?? "A green tick on this step.";
  const primary =
    action ??
    (step.primaryAction ? (
      <Link className="vc-btn-solid vcstep-primary" href={step.primaryAction.href}>
        {step.primaryAction.label}
      </Link>
    ) : null);

  return (
    <section className="vcstep" aria-labelledby="vcstep-title">
      <span className="micro-label">{stepEyebrow(step.stage, index, total)}</span>
      <h1 id="vcstep-title" className="vcstep-title">
        {step.title}
      </h1>
      {step.why && <p className="vcstep-why">{step.why}</p>}

      {step.status === "failed" && step.reason && (
        <p className="vcstep-reason" role="alert">
          {step.reason}
        </p>
      )}

      {primary && <div className="vcstep-action">{primary}</div>}

      <div className="vcstep-outcome">
        <span className="micro-label">What you should see</span>
        <p>{whatYouShouldSee}</p>
        {onRecheck && (
          <button className="vc-btn-quiet" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? (
              <>
                <span className="vch-spin" aria-hidden="true" />
                Checking…
              </>
            ) : (
              "I did this, check again"
            )}
          </button>
        )}
        {step.status === "verified" && (
          <p className="vcstep-verified">This step is done. You can move on.</p>
        )}
      </div>

      <div className="vcstep-branch">
        <button
          className="vcstep-branch-toggle"
          aria-expanded={branchOpen}
          onClick={() => setBranchOpen((v) => !v)}
        >
          That did not happen
        </button>
        {branchOpen && (
          <div className="vcstep-branch-body">
            {troubleshooting ?? (
              <p>
                No problem. Tap Ask {ASSISTANT_NAME}{" "}below and describe what you saw. {ASSISTANT_NAME}{" "}
                will walk you through it.
              </p>
            )}
            <button className="vc-btn-solid vcstep-ask" onClick={askVidi}>
              Ask {ASSISTANT_NAME}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export default StepFrame;
