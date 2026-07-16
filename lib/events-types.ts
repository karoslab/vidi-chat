import { workspacePath } from "./workspace.ts";

/**
 * Shared contract for the proactivity event spine (Workstream B2).
 *
 * Producers (ops Python jobs, the /api/events route, the Swift app) spool
 * VidiEvents as one JSON file each into ops/events/pending/. The broker
 * (lib/events.ts) reads them, applies the politeness policy (lib/policy.ts),
 * and delivers via the Hands server (speak/chime), the phone push channel
 * (lib/push.ts), or the queue (data/events/queued.jsonl).
 *
 * This file is the single source of truth for the shapes every side agrees
 * on. Keep it types + tiny constants only — no logic, no fs, no imports.
 */

export type EventPriority = "low" | "normal" | "high" | "critical";

export interface VidiEvent {
  /** "evt-<epochMs>-<rand>" — stable id, also the spool filename stem. */
  id: string;
  /** Epoch milliseconds the event was produced. */
  ts: number;
  /** Origin, e.g. "deploy" | "calendar" | "nightshift" | "app". */
  source: string;
  /** Machine kind, e.g. "dg.verdict.flip" | "calendar.pre_brief". */
  kind: string;
  priority: EventPriority;
  /** Short label for the queue / session preamble ("Release gate held myapp"). */
  title: string;
  /** Spoken-style phrasing, written for the ear. */
  spoken: string;
  /** Optional longer context (not spoken; shown in logs / brief-me). */
  detail?: string;
  /** Auto-drop after this many minutes if still undelivered. */
  ttlMinutes: number;
  /** Collapses repeats — same key while unresolved is dropped by the broker. */
  dedupeKey?: string;
}

export type Presence = "active" | "idle" | "away";

/** Live presence snapshot from the Mac app (via Hands /context or /act
 *  presence). Null anywhere means "unknown" — treat conservatively. */
export interface PresenceState {
  presence: Presence;
  idleSeconds: number;
  screenLocked: boolean;
  fullscreen: boolean;
  micActive: boolean;
  frontmostApp?: string;
}

/** Everything the pure policy decision needs, gathered by the broker. */
export interface PolicyInputs {
  now: Date;
  /** Null when the app is unreachable — policy must not assume presence. */
  presence: PresenceState | null;
  /** A calendar event is happening right now. */
  inMeeting: boolean;
  /** macOS Focus/DND on, or the owner toggled "quiet mode". */
  dndOrQuiet: boolean;
  /** Unprompted speeches already delivered today (budget = 6). */
  spokenTodayCount: number;
  /** Epoch ms of the last unprompted speech, or null (spacing = 20 min). */
  lastSpokenAtMs: number | null;
  /** Chimes already delivered today (budget = 10). */
  chimeTodayCount: number;
}

export type Delivery = "speak" | "chime" | "queue" | "push" | "drop";

export interface PolicyDecision {
  deliver: Delivery;
  /** Human-readable justification, logged for tuning. */
  reason: string;
}

/** Maildir-style spool: producers write to pending/, broker moves to done/. */
export const EVENTS_SPOOL_PENDING = workspacePath("ops", "events", "pending");
export const EVENTS_SPOOL_DONE = workspacePath("ops", "events", "done");

/** Daily budgets for unprompted delivery (the make-or-break politeness dial). */
export const MAX_SPOKEN_PER_DAY = 6;
export const MIN_SPOKEN_SPACING_MS = 20 * 60 * 1000;
export const MAX_CHIME_PER_DAY = 10;
