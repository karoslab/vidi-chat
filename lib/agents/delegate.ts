/**
 * Chat → fleet delegation: decide when a chat message should be handed to a
 * background fleet agent instead of answered inline, and extract the task.
 *
 * Two triggers:
 *  - explicit: the user literally asks for an agent ("spawn an agent to…",
 *    "have an agent do…", "delegate this…"). Honored in any mode — the user
 *    asked, so the trust question is settled.
 *  - complex: auto-mode only. A long, multi-step, build/research-shaped ask
 *    that would hog the chat for minutes runs better as a watchable agent.
 *    Deliberately conservative — a false "delegated your quick question to an
 *    agent" is far more annoying than answering a big ask inline.
 */

export type DelegationReason = "explicit" | "complex";

// "spawn/launch/use/have/get … agent" — imperative agent requests. Anchored
// on the word "agent" so ordinary sentences that merely mention agents in
// passing (e.g. "what do you think about agents?") don't match.
const EXPLICIT_AGENT_REQUEST =
  /\b(spawn|launch|start|create|kick\s*off|fire\s*up|use|have|get|send|ask)\b[^.?!]{0,40}\b(an?\s+|another\s+|background\s+)?agents?\b/i;
const EXPLICIT_DELEGATE = /\b(delegate|offload|hand(?:\s+this)?\s+off)\b/i;
// "do this in the background" — same intent, no "agent" word.
const EXPLICIT_BACKGROUND = /\bin\s+the\s+background\b/i;

// Verbs that mark a real multi-step work item (not a lookup question).
const WORK_VERBS =
  /\b(build|implement|create|write|refactor|migrate|audit|investigate|research|analy[sz]e|benchmark|port|redesign|rework|overhaul|set\s+up|scaffold|integrate|fix\s+all|review\s+(?:the\s+)?(?:whole|entire|all))\b/i;
// Phrases that signal the user expects depth, whatever the length.
const DEPTH_PHRASES =
  /\b(deep\s*dive|comprehensive|thorough(?:ly)?|end[-\s]to[-\s]end|from\s+scratch|full\s+(?:audit|review|report|analysis))\b/i;

/** Message length past which a work-shaped ask counts as "complicated". */
const COMPLEX_LENGTH_THRESHOLD = 240;

export function detectDelegation(
  message: string,
  mode: "plan" | "auto" | "chat" | "act"
): DelegationReason | null {
  const text = message.trim();

  if (
    EXPLICIT_AGENT_REQUEST.test(text) ||
    EXPLICIT_DELEGATE.test(text) ||
    EXPLICIT_BACKGROUND.test(text)
  ) {
    return "explicit";
  }

  // Auto-delegation only when Vidi already has write trust (auto mode) —
  // plan mode means the user wants inline read-only thinking, not a fleet
  // agent editing files.
  const isAutoMode = mode === "auto" || mode === "act";
  if (!isAutoMode) return null;

  if (DEPTH_PHRASES.test(text) && WORK_VERBS.test(text)) return "complex";
  if (text.length >= COMPLEX_LENGTH_THRESHOLD && WORK_VERBS.test(text)) {
    return "complex";
  }
  return null;
}

/**
 * Strip the "spawn an agent to" preamble so the agent gets the task itself,
 * not instructions about its own existence. Falls back to the full message
 * when the strip would leave nothing actionable.
 */
export function extractDelegatedTask(message: string): string {
  const stripped = message
    .trim()
    .replace(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:spawn|launch|start|create|kick\s*off|fire\s*up|use|have|get|send|ask)\s+(?:an?\s+|another\s+|background\s+)?agents?\s*(?:named\s+\w+\s+)?(?:to|and|that|for|on)?\s*/i,
      ""
    )
    .trim();
  return stripped.length >= 8 ? stripped : message.trim();
}

/**
 * Model policy for spawned agents (the owner, 2026-07-05): build-shaped tasks
 * run opus+ultracode, mechanical ones stay sonnet. "Build-shaped" reuses the
 * same signals delegation itself keys on — a real work verb or an explicit
 * depth ask. Callers map "build" to model:"auto" + effort:"high", which the
 * router resolves to opus+ultracode in act mode (see lib/models.ts).
 */
export function classifyTaskShape(task: string): "build" | "mechanical" {
  return WORK_VERBS.test(task) || DEPTH_PHRASES.test(task)
    ? "build"
    : "mechanical";
}
