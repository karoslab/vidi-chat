"use client";

import { useEffect, useState } from "react";
import { validateCustomAgentName } from "@/lib/agent-name-input";

/**
 * Agent-name picker for the fleet spawn bar (T1.2). A free-text field plus a
 * popover of the curated stacks from /api/agents/names — 4 stacks including the
 * Kannada / Indian-mythology stack, whose script is rendered as the undistorted
 * HERO (no transform, no filter — the respect-Kannada rule).
 *
 * The chosen name is reported up via onChange; the parent passes it straight to
 * POST /api/agents, which persists it to agents.json (the fleet manager already
 * stores agent.name). Custom input is validated against exactly what the
 * backend will store, so the user is never surprised by a silently reshaped
 * name.
 *
 * Extracted from Canvas.tsx so the same picker can be reused by the Phase 2
 * conversational naming step without duplicating the stack fetch or validation.
 */

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

export default function AgentNamePicker({
  name,
  onChange,
  onEnter,
}: {
  /** The current name value (controlled by the parent). */
  name: string;
  /** Called with the new name whenever the field or a picked stack entry changes. */
  onChange: (name: string) => void;
  /** Called when the user presses Enter in the field (parent triggers spawn). */
  onEnter?: () => void;
}) {
  const [nameStacks, setNameStacks] = useState<NameStack[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A4 — the user's preferred stack (the one nameless spawns draw from). The
  // picker opens with it highlighted, and offers a "use these by default"
  // affordance that writes it through the SAME guarded route (one source of
  // truth). null until the preference is fetched.
  const [preferredStackId, setPreferredStackId] = useState<string | null>(null);

  // Curated name stacks. Fail-open: if the fetch fails the popover just doesn't
  // populate and free-text naming still works.
  useEffect(() => {
    fetch("/api/agents/names")
      .then((r) => r.json())
      .then((j) => setNameStacks(j.stacks || []))
      .catch(() => {
        /* picker won't populate; free-text naming still works */
      });
  }, []);

  // Read the current preferred stack so the picker highlights it. Fail-open: if
  // it can't be read, nothing is highlighted and the picker still works.
  useEffect(() => {
    fetch("/api/user-config")
      .then((r) => r.json())
      .then((j) => {
        const stored = j?.fields?.agentNameStack?.value;
        if (typeof stored === "string" && stored) setPreferredStackId(stored);
      })
      .catch(() => {
        /* no highlight — picking a name still works */
      });
  }, []);

  /** Set the given stack as the default helper-name stack via the guarded
   *  /api/user-config route — the SAME write path onboarding and settings use.
   *  Optimistically highlights it; reverts on failure. */
  const setDefaultStack = (stackId: string) => {
    const previous = preferredStackId;
    setPreferredStackId(stackId); // optimistic
    fetch("/api/user-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentNameStack: stackId }),
    })
      .then((r) => {
        if (!r.ok) setPreferredStackId(previous); // revert on rejection
      })
      .catch(() => setPreferredStackId(previous));
  };

  // Validate what the user typed against exactly what the backend will store.
  const validation = validateCustomAgentName(name);

  return (
    <div className="name-field">
      <input
        value={name}
        placeholder="name (optional)"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Block spawn on invalid custom input (e.g. a name with no letters).
          if (e.key === "Enter" && validation.ok) onEnter?.();
        }}
        aria-invalid={!validation.ok}
      />
      {nameStacks.length > 0 && (
        <button
          className="name-pick-btn"
          title="Pick a name"
          onClick={() => setPickerOpen((open) => !open)}
        >
          ✦
        </button>
      )}
      {pickerOpen && nameStacks.length > 0 && (
        <div className="name-picker">
          {nameStacks.map((stack) => (
            <div
              className={`name-stack ${preferredStackId === stack.id ? "preferred" : ""}`}
              key={stack.id}
            >
              <div className="name-stack-head">
                <span className="name-stack-label">{stack.label}</span>
                {preferredStackId === stack.id ? (
                  <span className="name-stack-default-tag">default</span>
                ) : (
                  <button
                    className="name-stack-default-btn"
                    title="Use these names by default for new helpers"
                    onClick={() => setDefaultStack(stack.id)}
                  >
                    Use by default
                  </button>
                )}
              </div>
              {stack.names.map((entry) => (
                <button
                  className="name-option"
                  key={entry.name}
                  title={entry.meaning}
                  onClick={() => {
                    onChange(entry.name);
                    setPickerOpen(false);
                  }}
                >
                  {/* Kannada/Indian script is the hero: undistorted, no
                      transform or filter (respect-Kannada rule). */}
                  {entry.script && <span className="name-script">{entry.script}</span>}
                  <span className="name-roman">{entry.name}</span>
                  <span className="name-meaning">{entry.meaning}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {validation.note && <span className="name-note">{validation.note}</span>}
    </div>
  );
}
