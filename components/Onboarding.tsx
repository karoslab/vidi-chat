"use client";

import { useEffect, useState } from "react";
import {
  SECURITY_NOTICE_ACK_LABEL,
  securityNoticeSections,
  SECURITY_NOTICE_TITLE,
} from "@/lib/security-notice";
import { stepsToClearOnFinish } from "@/lib/deferred-onboarding-steps";
import {
  CapIcon,
  ConnectArt,
  HelpersArt,
  NoticeIcon,
  noticeIconKind,
  TwoWindowsStrip,
} from "./onboarding/OnbArt";
import GhostDemo from "./onboarding/GhostDemo";
import ClaudeStep from "./journey/steps/ClaudeStep";
import WorkingGlow from "./WorkingGlow";
import { usePersonaName, USER_CONFIG_CHANGED_EVENT } from "./usePersonaName";

// Short step labels for the "Step N of 7" kicker — a lost novice can always
// tell where they are and what this screen is about.
const STEP_LABELS = [
  "Connect",
  "Your name",
  "How I sound",
  "Privacy",
  "What I can do",
  "Your helpers",
  "First words",
];

interface Personality {
  id: string;
  label: string;
  blurb: string;
}

interface BackendStatus {
  id: string;
  label: string;
  installed: boolean;
  loggedIn: boolean;
  hint: string | null;
}

// The curated agent-name stacks (A2 "Name your helpers" step), fetched from
// /api/agents/names — the SAME source the Canvas picker uses.
interface CuratedName {
  name: string;
  script?: string;
  meaning: string;
}
interface NameStack {
  id: string;
  label: string;
  names: CuratedName[];
}
// The Kannada / Indian-mythology stack is the DEFAULT selection (the owner's
// ruling — the hero set). Kept in sync with DEFAULT_AGENT_NAME_STACK_ID; a
// literal here avoids pulling the server module into the client bundle.
const DEFAULT_HELPER_STACK_ID = "kannada";

/**
 * First-run onboarding (P4.1 + Phase-2 additions). Shown only when
 * /api/onboarding reports onboarded:false (a brand-new install with no
 * threads). Steps, in order:
 *   0. BACKEND CHECK (T2.1) — server-side detection of the claude/codex CLIs
 *      (installed + logged in) with a green check per verified backend; no raw
 *      key field ever. If nothing verifies, plain-language "log in via the CLI"
 *      instructions + a re-check button.
 *   1. name
 *   2. personality pick (a stored tone preference — the app's voice is ara,
 *      server-side, so this is honestly a tone, not a new voice system)
 *   3. SECURITY NOTICE (T2.3) — one plain-language "what I can/can't see & do"
 *      screen, shown BEFORE the permissions walkthrough.
 *   4. plain-language permissions/capability walkthrough
 *   5. NAME YOUR HELPERS (A2) — pick which curated stack the helpers Vidi sends
 *      out draw their names from; the Kannada mythology stack is preselected.
 *   6. a "what you can say" starter card
 *
 * SKIP-AND-DEFER (T2.4): every step has a visible "Skip for now". Skipping files
 * the step to the deferred checklist (surfaced in Settings as "finish setting
 * up") and advances — nothing blocks reaching a working chat. In replay mode a
 * skip just advances (replay never writes anything). A fully-completed flow
 * clears the checklist.
 *
 * On finish it POSTs the profile and calls onDone so the parent hides it and
 * re-reads the (now personalized) greeting.
 *
 * REPLAY MODE (T1.5): when `replay` is true the flow is shown again from
 * settings as a re-watchable intro. It does NOT write anything — an existing
 * user re-watching the intro must never have her profile/config rewritten (the
 * server also guards this via isOnboarded(), so replay is safe either way). The
 * only exit is "Close", which calls onDone without a save.
 *
 * SCOPED-STEP MODE (FW3): when `scopedStep` is a deferred-checklist id, ONLY
 * that one step renders, in a real completing (non-replay) mode. Completing it
 * persists for real (the "name" step writes displayName via the guarded
 * user-config route) and clears the item from the checklist (resolveStep). This
 * is what makes a deferred item actually finishable — the old jump-to-replay
 * path wrote nothing and never called resolveStep, so a deferred step could
 * never be completed or cleared.
 */

const STEP_COUNT = 7;
// Step index → deferred-checklist id (T2.4). Personality (step 2) isn't a
// deferrable line item — it's a preference, not a setup task — so it has no id.
// Step 5 ("Name your helpers", A2) sits after the capabilities walkthrough and
// before the starter card.
const STEP_DEFER_ID: Record<number, string | undefined> = {
  0: "backends",
  1: "name",
  2: undefined,
  3: "security",
  4: "permissions",
  5: "helpers",
  6: "starters",
};
// Reverse map (FW3): a deferred-checklist id → its step index, so a "finish
// setting up" item can deep-link into onboarding AT its own step.
const DEFER_ID_STEP: Record<string, number> = {
  backends: 0,
  name: 1,
  security: 3,
  permissions: 4,
  helpers: 5,
  starters: 6,
};

export default function Onboarding({
  personalities,
  onDone,
  replay = false,
  scopedStep,
  ownerInstall = false,
}: {
  personalities: Personality[];
  onDone: (name: string) => void;
  replay?: boolean;
  /**
   * Which security-notice story is TRUE for this install (server-resolved
   * isOwner(), carried on GET /api/onboarding): an owner install can flip
   * Plan→Auto herself and voice is live; a non-owner install is clamped to
   * Plan. Defaults to the conservative non-owner story.
   */
  ownerInstall?: boolean;
  /**
   * FW3 — scoped single-step COMPLETING mode. When set to a deferred-checklist
   * id, the flow renders only that one step in a real (non-replay) completing
   * mode: completing it persists for real (the "name" step writes displayName
   * via the guarded user-config route) and calls resolveStep so the checklist
   * item actually clears. Distinct from `replay`, which shows all 6 steps and
   * writes nothing (so a deferred item could never be completed from it).
   */
  scopedStep?: string;
}) {
  // In scoped mode, open directly on that step; else start at the top.
  const scopedStepIndex = scopedStep != null ? DEFER_ID_STEP[scopedStep] : undefined;
  const [step, setStep] = useState(scopedStepIndex ?? 0);
  const personaName = usePersonaName();
  // The assistant's per-install name (customer ruling 2026-07-12): pickable
  // right here in onboarding. Prefilled from config; env-locked installs
  // (the launcher preconfigured "Anna") show it fixed instead of editable.
  const [assistantDraft, setAssistantDraft] = useState("");
  const [assistantLocked, setAssistantLocked] = useState(false);
  // Memory-folder derivation ("Niranjan" types their name, gets NiranjanWiki):
  // only when the stored folder is still a shipped default and not env-locked.
  const [brainDirCurrent, setBrainDirCurrent] = useState("");
  const [brainDirLocked, setBrainDirLocked] = useState(true);
  const [name, setName] = useState("");
  const [personality, setPersonality] = useState(personalities[0]?.id ?? "warm");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // FW4 — the deferred-checklist ids of steps COMPLETED in this run (advanced
  // via their primary action, not skipped). finish() clears ONLY these, so a
  // step the user skipped this run (its item just filed to the checklist) is
  // never erased by finishing at a later step.
  const [completedStepIds, setCompletedStepIds] = useState<Set<string>>(new Set());

  // Backend detection (step 0). null = still checking.
  const [backends, setBackends] = useState<BackendStatus[] | null>(null);
  const [rechecking, setRechecking] = useState(false);

  // Weekly-health-summary consent — drives whether the security notice discloses
  // that consented egress. Default OFF; only true when the user turned it on in
  // Settings (so during first-run it's off, and a later replay reflects reality).
  const [weeklySummaryOn, setWeeklySummaryOn] = useState(false);
  useEffect(() => {
    fetch("/api/feedback/consent")
      .then((r) => r.json())
      .then((j) => setWeeklySummaryOn(j.weeklySummary === true))
      .catch(() => {
        /* fail-closed: leave the disclosure off if we can't read consent */
      });
  }, []);

  // A2 "Name your helpers" step (5): the curated stacks + the picked stack id.
  // Kannada mythology is PRESELECTED as the default.
  const [nameStacks, setNameStacks] = useState<NameStack[]>([]);
  const [helperStackId, setHelperStackId] = useState<string>(DEFAULT_HELPER_STACK_ID);

  const loadBackends = async () => {
    setRechecking(true);
    try {
      const r = await fetch("/api/onboarding/backends");
      const j = await r.json();
      setBackends(Array.isArray(j.backends) ? j.backends : []);
    } catch {
      // Fail-open: detection failing must never trap the user — show it as
      // "couldn't check" via an empty list + let them continue.
      setBackends([]);
    } finally {
      setRechecking(false);
    }
  };

  useEffect(() => {
    loadBackends();
  }, []);

  // Load the curated stacks for the "Name your helpers" step. Fail-open: if the
  // fetch fails the step shows nothing to pick and the Kannada default persists
  // on completion anyway.
  useEffect(() => {
    fetch("/api/agents/names")
      .then((r) => r.json())
      .then((j) => setNameStacks(Array.isArray(j.stacks) ? j.stacks : []))
      .catch(() => {
        /* no stacks to show; the default preference still applies */
      });
  }, []);

  // In scoped "helpers" mode (a deferred item deep-linked from settings),
  // preselect the CURRENTLY stored stack so the user edits rather than resets.
  useEffect(() => {
    if (scopedStep !== "helpers") return;
    fetch("/api/user-config")
      .then((r) => r.json())
      .then((j) => {
        const stored = j?.fields?.agentNameStack?.value;
        if (typeof stored === "string" && stored) setHelperStackId(stored);
      })
      .catch(() => {
        /* fall back to the Kannada default already in state */
      });
  }, [scopedStep]);

  // FW3 — in scoped "name" mode, prefill the input with the current name so the
  // user edits rather than retypes (and "Done" isn't blocked on an empty field).
  useEffect(() => {
    if (scopedStep !== "name") return;
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.displayName === "string" && j.displayName) setName(j.displayName);
      })
      .catch(() => {
        /* fall back to an empty field — the user can type a name */
      });
  }, [scopedStep]);

  useEffect(() => {
    fetch("/api/user-config")
      .then((r) => r.json())
      .then((j) => {
        const f = j?.fields?.assistantName;
        if (typeof f?.value === "string" && f.value) setAssistantDraft(f.value);
        setAssistantLocked(!!f?.envLocked);
        const b = j?.fields?.brainDirName;
        if (typeof b?.value === "string") setBrainDirCurrent(b.value);
        setBrainDirLocked(!!b?.envLocked);
      })
      .catch(() => {
        /* keep the brand default; the field still works */
      });
  }, []);

  // Raw forward move — no completion bookkeeping (used by skip, which must NOT
  // mark the skipped step as completed).
  const advance = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1));

  /** Persist the picked helper-name stack through the guarded /api/user-config
   *  route (the ONE source of truth — same route the settings panel and Canvas
   *  picker write). Fire-and-forget in the linear flow; replay never writes. A
   *  failure is silent here — the default already applies and the user can
   *  re-pick from settings. */
  const persistHelperStack = () => {
    if (replay) return;
    fetch("/api/user-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentNameStack: helperStackId }),
    }).catch(() => {});
  };

  const goNext = () => {
    // Advancing via a step's PRIMARY action counts as completing it (FW4). Its
    // deferred id (if any) is recorded so finish() clears only truly-done steps.
    const id = STEP_DEFER_ID[step];
    if (id && !replay) setCompletedStepIds((prev) => new Set(prev).add(id));
    // Completing the "Name your helpers" step persists the pick through the
    // guarded route (A2). Skipping (skipStep) does NOT call this — the default
    // stays and a deferred item is filed.
    if (id === "helpers") persistHelperStack();
    advance();
  };
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  /** File a step to the deferred checklist (real flow only — replay never
   *  writes). Fire-and-forget; a failure never blocks advancing. */
  const deferStepOnServer = (stepIndex: number) => {
    if (replay) return;
    const id = STEP_DEFER_ID[stepIndex];
    if (!id) return;
    fetch("/api/onboarding/deferred", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "defer", step: id }),
    }).catch(() => {});
  };

  /** Skip THIS step: defer it, then advance (or finish if it's the last one).
   *  Skipping the last (starters) step finishes WITHOUT marking starters
   *  completed (FW4), so its deferred item survives the finish. */
  const skipStep = () => {
    deferStepOnServer(step);
    if (step >= STEP_COUNT - 1) finish(false);
    else advance();
  };

  /**
   * Finish the flow. `starterStepCompleted` is true when reached via the
   * starters step's own primary action ("Start using Vidi"), false when reached
   * by SKIPPING the starters step (FW4) — the latter must not clear the starters
   * deferred item. On success we resolve ONLY the steps completed in this run
   * (plus starters if its primary fired), so a step the user skipped this run
   * keeps its freshly-filed checklist item instead of being erased by a
   * blanket clear.
   */
  const finish = async (starterStepCompleted = true) => {
    // Replay is a re-watch, not a re-onboard: never write, just close.
    if (replay) {
      onDone(name.trim() || "there");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), personality }),
      });
      if (!r.ok) throw new Error(`save failed (${r.status})`);
      // Persist the assistant's chosen name through the guarded user-config
      // route (skipped when env-locked; the server enforces the lock anyway),
      // then tell the rail/composer so the new name shows without a reload.
      const identity: Record<string, string> = {};
      if (!assistantLocked && assistantDraft.trim()) {
        identity.assistantName = assistantDraft.trim();
      }
      // Their memory folder takes THEIR name (e.g. "AnnaWiki"), never a shipped
      // default, and only before the folder has really become theirs.
      const nameSlug = name.trim().replace(/[^A-Za-z0-9]+/g, "");
      const folderIsDefault = ["", "MyWiki"].includes(brainDirCurrent);
      if (!brainDirLocked && folderIsDefault && nameSlug) {
        identity.brainDirName = `${nameSlug[0].toUpperCase()}${nameSlug.slice(1)}Wiki`;
      }
      if (Object.keys(identity).length > 0) {
        await fetch("/api/user-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(identity),
        }).catch(() => {});
        window.dispatchEvent(new Event(USER_CONFIG_CHANGED_EVENT));
      }
      // Clear ONLY the steps completed in this run — skipped steps' items must
      // survive (FW4). Pure decision (stepsToClearOnFinish) folds in the
      // starters step when its own primary action fired.
      const doneIds = stepsToClearOnFinish([...completedStepIds], starterStepCompleted);
      for (const doneId of doneIds) {
        fetch("/api/onboarding/deferred", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve", step: doneId }),
        }).catch(() => {});
      }
      onDone(name.trim() || "there");
    } catch {
      // Plain-language; detail (if any) is in the network tab / server log.
      setErr("Couldn't save that just now. Try Finish again in a moment.");
      setSaving(false);
    }
  };

  /**
   * FW3 — complete the ONE scoped deferred step for real, then clear it from the
   * checklist. Only the "name" step has data to persist: it writes displayName
   * through the guarded /api/user-config route (NOT /api/onboarding, which is a
   * no-op once onboarded). The informational steps (backends/security/
   * permissions/starters) have nothing to persist — acknowledging them IS the
   * completion. Either way we resolveStep so the checklist item disappears (the
   * bug: the old replay path never called resolveStep, so it never could).
   */
  const completeScopedStep = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (scopedStep === "name") {
        const trimmed = name.trim();
        if (!trimmed) {
          setErr("Please enter a name first.");
          setSaving(false);
          return;
        }
        const r = await fetch("/api/user-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: trimmed }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "save failed");
      } else if (scopedStep === "helpers") {
        // Persist the picked stack through the SAME guarded route.
        const r = await fetch("/api/user-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentNameStack: helperStackId }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "save failed");
      }
      // Clear just THIS item (resolve, not clear-all) so other deferred steps
      // survive — completing one step must not erase the rest.
      await fetch("/api/onboarding/deferred", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", step: scopedStep }),
      }).catch(() => {});
      onDone(name.trim() || "there");
    } catch (e: any) {
      setErr(
        e?.message?.startsWith("Couldn't") || e?.message?.startsWith("That")
          ? e.message
          : "Couldn't save that just now. Try again in a moment."
      );
      setSaving(false);
    }
  };

  const nameValid = name.trim().length > 0;
  // What the assistant is called RIGHT NOW on this screen (draft wins so the
  // header/preview react as they type; falls back to the stored persona).
  const liveAssistantName = assistantDraft.trim() || personaName;
  // Claude is handled by the embedded in-app connect flow (ClaudeStep) below;
  // the wizard only surfaces Codex live status here, since Codex has no in-app
  // sign-in flow (the customer signs in with the Codex app, then re-checks).
  const codexBackend = backends?.find((b) => b.id === "codex") ?? null;

  // FW3 — the scoped single-step action row: one "Done" that completes THIS
  // step for real and clears it from the checklist. Replaces the normal
  // Back/Skip/Next row in scoped mode. Disabled for the name step until a name
  // is entered.
  const scopedActionRow = (
    <div className="onb-actions">
      <button className="onb-btn" onClick={() => onDone(name.trim() || "there")} disabled={saving}>
        Cancel
      </button>
      <button
        className="onb-btn onb-btn-primary"
        onClick={completeScopedStep}
        disabled={saving || (scopedStep === "name" && !nameValid)}
      >
        {saving ? "Saving…" : "Done"}
      </button>
    </div>
  );

  // A per-step "Skip for now" button (T2.4), rendered on every step's action
  // row. In replay it still advances but files nothing (deferStepOnServer
  // no-ops in replay). Pushed to the left so it never competes with the
  // primary action.
  const skipButton = (
    <button className="onb-btn onb-btn-skip" onClick={skipStep} disabled={saving}>
      Skip for now
    </button>
  );

  return (
    <div className="onb-backdrop">
      <div className="onb-card">
        {replay && (
          <button
            className="settings-close onb-replay-close"
            title="Close"
            aria-label="Close"
            onClick={() => onDone(name.trim() || "there")}
          >
            ✕
          </button>
        )}
        <div className="onb-hero">
          <div className="big-monogram">V</div>
        </div>
        {!scopedStep && (
          <div className="onb-step-kicker">
            Step {step + 1} of {STEP_COUNT} · {STEP_LABELS[step]}
          </div>
        )}

        {step === 0 && (
          <div className="onb-step">
            <ConnectArt />
            <h2>Let&apos;s connect your assistant.</h2>
            <p>
              I&apos;m an AI assistant that runs on your own Claude or Codex
              account. That&apos;s the AI subscription I use, right here on your
              computer. There are no keys or setup for you to fill in. Let&apos;s
              get you connected, right here:
            </p>

            {/* Claude: the SAME in-app connect flow the setup board hosts —
                install the AI brain, sign in with your own account, and see
                live status, all without leaving this screen. No Helper menu,
                no Terminal. */}
            <ClaudeStep embedded onDone={loadBackends} />

            {/* Codex is optional and has no in-app sign-in. Show its live
                status with a plain re-check line when it isn't connected. */}
            {backends === null ? (
              <WorkingGlow lines={["Checking your accounts…"]} />
            ) : codexBackend && !codexBackend.loggedIn ? (
              <div className="onb-backends">
                <div className="onb-backend unverified">
                  <span className="onb-backend-check" aria-hidden="true">
                    ○
                  </span>
                  <div className="onb-backend-body">
                    <span className="onb-backend-label">{codexBackend.label}</span>
                    <span className="onb-backend-state">Not connected</span>
                    {codexBackend.hint && (
                      <span className="onb-backend-hintline">{codexBackend.hint}</span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            <TwoWindowsStrip />
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                {skipButton}
                <button
                  className="onb-btn"
                  onClick={loadBackends}
                  disabled={rechecking}
                >
                  {rechecking ? "Checking…" : "Re-check"}
                </button>
                <button className="onb-btn onb-btn-primary" onClick={goNext}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="onb-step">
            <h2>Hi, I&apos;m {liveAssistantName}.</h2>
            <p>
              I&apos;m your assistant, an AI that can read the files on your
              computer to answer you, remember things for you, and get real work
              done. First, so I can greet you properly: what should I call you?
            </p>
            <input
              className="onb-input"
              autoFocus
              value={name}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameValid) goNext();
              }}
            />
            <label className="settings-label onb-assistant-label">
              And what would you like to call me?
              {assistantLocked && <span className="settings-env-badge">chosen for this install</span>}
            </label>
            <input
              className="onb-input"
              value={assistantDraft}
              placeholder="Vidi"
              disabled={assistantLocked}
              onChange={(e) => setAssistantDraft(e.target.value)}
            />
            <div className="settings-help">
              Keep it, or pick any name you like. Everything here will answer to it.
            </div>
            {/* Live preview: the greeting rewrites itself as they type — the
                names aren't abstract form fields, they're how we'll talk. */}
            <div className="onb-preview">
              <span className="onb-preview-kicker">How I&apos;ll greet you</span>
              <div className="onb-bubble">
                Hi{name.trim() ? `, ${name.trim()}` : " there"}. {liveAssistantName}{" "}here. Ready when you are.
              </div>
            </div>
            {err && <div className="onb-error">{err}</div>}
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                <button className="onb-btn" onClick={goBack}>
                  Back
                </button>
                {skipButton}
                <button
                  className="onb-btn onb-btn-primary"
                  disabled={!nameValid}
                  onClick={goNext}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="onb-step">
            <h2>How should I sound?</h2>
            <p>
              Pick the tone you&apos;d like me to use when I talk with you.
              It only changes how I sound. You can change it anytime later.
            </p>
            <div className="onb-personalities">
              {personalities.map((p) => (
                <button
                  key={p.id}
                  className={`onb-persona ${personality === p.id ? "selected" : ""}`}
                  onClick={() => setPersonality(p.id)}
                >
                  <span className="onb-persona-label">{p.label}</span>
                  <span className="onb-persona-blurb">{p.blurb}</span>
                </button>
              ))}
            </div>
            {/* Hear the difference, don't imagine it: one sample line in the
                selected tone, swapping live as they click through the cards. */}
            <div className="onb-preview">
              <span className="onb-preview-kicker">How I&apos;d sound</span>
              <div className="onb-bubble">
                {personality === "direct"
                  ? "Ready. Three things need your eyes today. Want the list?"
                  : personality === "playful"
                    ? `Back already${name.trim() ? `, ${name.trim()}` : ""}? Your files and I were just talking about you.`
                    : `Good to see you${name.trim() ? `, ${name.trim()}` : ""}. Whenever you're ready, we'll take it one step at a time.`}
              </div>
            </div>
            <div className="onb-actions">
              <button className="onb-btn" onClick={goBack}>
                Back
              </button>
              <button className="onb-btn onb-btn-primary" onClick={goNext}>
                Next
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onb-step">
            <h2>{SECURITY_NOTICE_TITLE}</h2>
            <div className="onb-notice">
              {/* Same reviewed disclosure copy, word for word — only the
                  presentation changed: each group gets an icon + accent rail
                  so the four ideas are tellable apart at a glance. */}
              {securityNoticeSections(ownerInstall, weeklySummaryOn).map((section) => (
                <div className="onb-notice-section" key={section.heading}>
                  <div className="onb-notice-heading">
                    <NoticeIcon kind={noticeIconKind(section.heading)} />
                    {section.heading}
                  </div>
                  <ul className="onb-notice-points">
                    {section.points.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                <button className="onb-btn" onClick={goBack}>
                  Back
                </button>
                {skipButton}
                <button className="onb-btn onb-btn-primary" onClick={goNext}>
                  {SECURITY_NOTICE_ACK_LABEL}
                </button>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="onb-step">
            <h2>What I can do, and what I&apos;ll ask first.</h2>
            <ul className="onb-caps onb-caps-iconed">
              <li>
                <CapIcon kind="read" />
                <span>
                  <b>Answer &amp; read.</b>{" "}
                  Ask me anything. To answer, I&apos;ll go
                  read the files on your computer, but just reading never changes
                  anything.
                </span>
              </li>
              <li>
                <CapIcon kind="modes" />
                <span>
                  <b>Two modes.</b>{" "}
                  In <b>Plan</b>{" "}mode I only look and think. I
                  won&apos;t touch anything. In <b>Auto</b>{" "}mode I can also make
                  changes for you, like creating or editing a file.
                </span>
              </li>
              <li>
                <CapIcon kind="ask" />
                <span>
                  <b>I ask before anything risky.</b>{" "}
                  Deleting, deploying, spending,
                  or acting as you on a website. I&apos;ll stop and ask for a clear
                  yes first. Nothing big happens without your say-so.
                </span>
              </li>
              <li>
                <CapIcon kind="control" />
                <span>
                  <b>You&apos;re always in control.</b>{" "}
                  You can stop me at any time,
                  and I&apos;ll tell you plainly if something goes wrong.
                </span>
              </li>
            </ul>
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                <button className="onb-btn" onClick={goBack}>
                  Back
                </button>
                {skipButton}
                <button className="onb-btn onb-btn-primary" onClick={goNext}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="onb-step">
            <HelpersArt />
            <h2>Name your helpers.</h2>
            <p>
              When there&apos;s real work to do, I can send out helpers, small
              assistants that go off and work on a task for you while we keep
              talking. Each helper gets a name, and you pick which set of names
              they come from. Here are a few sets. The Kannada mythology one is
              chosen for you to start:
            </p>
            <div className="onb-helper-stacks">
              {nameStacks.map((stack) => (
                <button
                  key={stack.id}
                  className={`onb-helper-stack ${helperStackId === stack.id ? "selected" : ""}`}
                  onClick={() => setHelperStackId(stack.id)}
                  aria-pressed={helperStackId === stack.id}
                >
                  <span className="onb-helper-stack-label">{stack.label}</span>
                  <span className="onb-helper-stack-names">
                    {/* Show the first few names as a taste. For the Kannada set
                        the script is the undistorted HERO with its romanization
                        and meaning — no transform, no filter (respect-Kannada
                        rule). */}
                    {stack.names.slice(0, 3).map((entry) => (
                      <span className="onb-helper-name" key={entry.name}>
                        {entry.script && (
                          <span className="name-script">{entry.script}</span>
                        )}
                        <span className="onb-helper-name-roman">{entry.name}</span>
                        <span className="onb-helper-name-meaning">{entry.meaning}</span>
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
            <p className="onb-helper-note">
              You can always type a completely custom name for a helper when you
              send one out. This just sets the default set.
            </p>
            {err && <div className="onb-error">{err}</div>}
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                <button className="onb-btn" onClick={goBack}>
                  Back
                </button>
                {skipButton}
                <button className="onb-btn onb-btn-primary" onClick={goNext}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {step === 6 && (
          <div className="onb-step">
            <h2>Watch how easy this is.</h2>
            {/* The finale shows instead of telling: a scripted miniature chat
                plays itself — a question types in, sends, and the answer
                streams back — cycling through the starter ideas. */}
            {/* No "type below" hint: during first-run the real composer is
                hidden behind this card (2026-07-12 demo feedback) — the
                spotlight tour points at the real box right after this. */}
            <GhostDemo personaName={liveAssistantName} />
            {err && <div className="onb-error">{err}</div>}
            {scopedStep ? scopedActionRow : (
              <div className="onb-actions">
                <button className="onb-btn" onClick={goBack} disabled={saving}>
                  Back
                </button>
                {/* No Skip on the finale: it finished the flow exactly like the
                    primary button and read as broken (2026-07-12 feedback). */}
                <button className="onb-btn onb-btn-primary" onClick={() => finish(true)} disabled={saving}>
                  {replay ? "Done" : saving ? "Saving…" : `Start using ${liveAssistantName}`}
                </button>
              </div>
            )}
          </div>
        )}

        {!scopedStep && (
          <div className="onb-dots">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} className={`onb-dot ${i === step ? "active" : ""}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
