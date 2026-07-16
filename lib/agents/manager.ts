import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../data-dir.ts";
import { appendJournal } from "../journal.ts";
import { memoryDigest } from "../memory.ts";
import { createThread, getThread, updateThread, withTurnLock } from "../store.ts";
import { computeFingerprint, shouldResumeSession } from "../session-fingerprint.ts";
import type { ThreadMode } from "../providers/types.ts";
import { plainLanguageProviderError } from "../provider-error.ts";
import { recordProviderDiag } from "../diag-ledger.ts";
import { nameStackByIdOrDefault } from "../agent-names.ts";
import { getPreferredAgentNameStackId, getUserConfig } from "../user-config.ts";
import { workerEffort, workerModelFor } from "../model-policy.ts";
import { fenceUntrusted } from "../untrusted.ts";

/**
 * Fleet manager — the Phase 1 named-agent layer (CNVS "spawn and prompt
 * agents" ported). Each agent is a named persona backed by one persistent
 * thread; turns run headless via the existing providers (stream-json, NOT
 * node-pty), so we get structured tool/token events for the live card feed
 * for free and reuse the Phase 0 kill registry, quota ledger, abort paths and
 * per-thread locks unchanged.
 *
 * Agents run genuinely in parallel (different threads); turns on ONE agent
 * serialize via withTurnLock and a working-state guard. The registry is
 * stashed on globalThis so next dev HMR / a launchd single process don't fork
 * it. Live state (status, feed ring buffer) is in-memory and ephemeral —
 * rebuilt as idle on restart from data/agents.json.
 */

export type AgentStatus = "idle" | "working" | "error";

/**
 * Who initiated this agent — the axis the Canvas visibility filter keys on.
 *   - "chat"   : the user delegated it from the main chat (or a voice command).
 *   - "manual" : the user created it on the Canvas (+Spawn) or started a loop by
 *                hand.
 *   - "goal"   : a standing-goal tick spawned it as background autonomy.
 *   - "system" : any other automation/coordination spawn (an agent asking the
 *                control plane for a sibling).
 * Only "chat" and "manual" are user-INITIATED, so only those render as Canvas
 * panes and count toward "N active" (isUserVisibleOrigin). Background agents
 * ("goal"/"system") still spawn and run exactly as before — this axis governs
 * DISPLAY + PERSISTENCE scope, never behavior. */
export type AgentOrigin = "chat" | "manual" | "goal" | "system";

const VALID_ORIGINS: ReadonlySet<string> = new Set<AgentOrigin>([
  "chat",
  "manual",
  "goal",
  "system",
]);

/** The two user-initiated origins the Canvas renders + counts. Background
 *  ("goal"/"system") agents are excluded from panes and the active badge. */
export function isUserVisibleOrigin(origin: AgentOrigin): boolean {
  return origin === "chat" || origin === "manual";
}

export interface FeedEvent {
  type: "user" | "delta" | "tool" | "done" | "error" | "system";
  ts: number;
  text?: string;
  tool?: string;
  summary?: string;
}

interface AgentRuntime {
  id: string; // == threadId
  name: string; // persona callsign
  provider: string;
  model: string | null;
  mode: ThreadMode;
  /** Reasoning effort passed to every turn ("high" on build-shaped
   *  delegations → opus+ultracode via the router); null = router default. */
  effort?: string | null;
  status: AgentStatus;
  createdAt: number;
  lastActivity: number;
  turns: number;
  tokens: { input: number; output: number };
  feed: FeedEvent[];
  abort?: AbortController;
  /** Chat thread that delegated the current task; the turn's final answer is
   *  posted back there ("agent completed — here's your answer"). One-shot:
   *  cleared after reporting so later Canvas prompts stay on the canvas. */
  originThreadId?: string | null;
  /** Who initiated this agent — governs Canvas visibility (see AgentOrigin). */
  origin: AgentOrigin;
  /** Spawn depth (H10). A user-spawned agent is depth 0; an agent it spawns
   *  would be depth 1 — but a depth-0 agent is the DEEPEST allowed to spawn, so
   *  a depth>=1 agent's spawn is hard-refused. Enforces the "no self-escalating
   *  fleet" mechanism (was an advisory in the control brief). */
  depth: number;
}

export interface AgentPublic {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  mode: ThreadMode;
  status: AgentStatus;
  createdAt: number;
  lastActivity: number;
  turns: number;
  tokens: { input: number; output: number };
  feed: FeedEvent[];
  originThreadId?: string | null;
  origin: AgentOrigin;
  depth: number;
}

export type FleetEvent =
  | { kind: "spawn" | "close" | "update"; agent: AgentPublic }
  | {
      kind: "feed";
      agentId: string;
      event: FeedEvent;
      status: AgentStatus;
      /** Carried so a consumer (the Canvas SSE route) can drop feed lines from
       *  background agents without a registry lookup. */
      origin: AgentOrigin;
    };

// Legacy fail-open fallback pool (Mahabharata callsigns — the owner's pick,
// 2026-07-02). A3: a nameless spawn now draws from the user's PREFERRED stack
// (lib/agent-names.ts) first; this pool is only reached if the preference is
// totally unreadable, so a spawn is never blocked by config.
const NAME_POOL = [
  "Abhimanyu", // Arjuna's son
  "Ghatotkacha", // Bhima's son
  "Babruvahana", // Arjuna's son
  "Iravan", // Arjuna's son
  "Prativindhya", // Yudhishthira's son (eldest Upapandava)
  "Sutasoma", // Bhima's son (Upapandava)
  "Shrutakarma", // Arjuna's son (Upapandava)
  "Shatanika", // Nakula's son (Upapandava)
  "Shrutasena", // Sahadeva's son (Upapandava)
  "Lakshmana", // Duryodhana's son
  "Lakshmanaa", // Duryodhana's daughter
  "Durmashana", // Dushasana's son
];
/**
 * The deterministic shape of a goal-tick-generated agent name: startLoop's
 * spawn passes agentName "goal-<slug>" as an EXPLICIT name, so pickName's
 * sanitizer (letters only, capitalize first) turns it into
 * "Goal" + <slug-letters, no hyphens> — e.g. "goal-vidichat-suite-health" →
 * "Goalvidichatsuitehealth" — and a name collision on a later tick appends
 * pickName's own numeric dedupe suffix ("...health2", "...health3", …).
 *
 * QA fix (PR #48 review): the original migration inferred "goal" from a bare
 * lc.startsWith("goal") check, which also swallowed a legitimate short
 * legacy user name like "Goalie" — a false hide the docstring itself said not
 * to do. A real goal slug is a slugified TITLE (kebab-cased words squashed
 * together by pickName's letter-only strip), so it reliably runs to several
 * concatenated words — every observed polluter has >=9 letters after "Goal"
 * (docstruth=9, vidichatsuitehealth=19, proactivedeliveryhealth=23).
 * Requiring >=6 trailing letters (optionally followed by the numeric dedupe
 * suffix) catches all of those with margin while a short common word like
 * "Goalie" (2 letters after "Goal") falls through to "manual".
 */
const GOAL_TICK_NAME = /^Goal([a-z]{6,})\d*$/i;

/**
 * Migration for a legacy agents.json row written before the origin tag existed
 * (item 4). A row with a valid stored `origin` is trusted as-is; otherwise we
 * infer from the name so the owner's canvas comes up clean without hand-editing
 * state:
 *   - name matches the deterministic goal-tick shape (GOAL_TICK_NAME above) →
 *     "goal" (hidden) — this is the only inferred-hidden case.
 *   - anything else → "manual" (visible). This INCLUDES a legacy Mahabharata
 *     fallback-pool callsign (Abhimanyu, Ghatotkacha, …): those names were also
 *     handed out to real user-initiated spawns pre-A3 (before the preferred-
 *     name-stack default), so hiding on callsign alone risked exactly the
 *     false-hide the QA review caught. The safe default is to SHOW an
 *     ambiguous legacy row, not silently hide it.
 * Going forward every spawn stamps an explicit origin, so this inference only
 * ever runs against pre-migration rows.
 */
function inferLegacyOrigin(name: string): AgentOrigin {
  const trimmed = (name || "").trim();
  if (GOAL_TICK_NAME.test(trimmed)) return "goal";
  return "manual";
}

const FEED_CAP = 200;
// Runaway backstop: agents can spawn siblings via the control plane, so cap
// the total fleet. The kill switch and quota ledger are the other backstops.
const MAX_AGENTS = 8;
// Resolved at CALL time via the shared dataDir() (VIDI_DATA_DIR override, else
// <cwd>/data) — unset is byte-identical to <cwd>/data/agents.json.
const agentsFile = () => dataPath("agents.json");
// Append-only durable log of turn-completion transitions (working→idle /
// working→error). The static roster in agents.json is not a transition source,
// so the ops agent.finished producer watermarks off THIS file instead. Resolved
// at call time (shared dataDir()) so a fresh install / tests point at the right dir.
const transitionsFile = () => dataPath("agents-transitions.jsonl");
// The bundled control CLI lives under bin/, not data/ — left cwd-relative.
const VIDICTL = path.join(process.cwd(), "bin", "vidictl.mjs");

/**
 * Record one turn-completion transition for the ops producer to consume. One
 * JSON line: {agentId, name, status, ts, summary}. summary = first ~120 chars
 * of the final assistant text when available, else "". Append-only and
 * strictly fail-open: a logging error must NEVER break the turn it describes.
 */
function recordTransition(
  agent: AgentRuntime,
  status: "idle" | "error",
  finalText?: string
): void {
  try {
    const summary = (finalText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const line =
      JSON.stringify({ agentId: agent.id, name: agent.name, status, ts: Date.now(), summary }) +
      "\n";
    fs.mkdirSync(path.dirname(transitionsFile()), { recursive: true });
    fs.appendFileSync(transitionsFile(), line);
  } catch {
    /* the transition log is best-effort telemetry, never a turn dependency */
  }
}

/**
 * Caveman output style (ported from github.com/JuliusBrussee/caveman
 * SKILL.md, "full" level) — injected into every fleet turn so Canvas agent
 * cards read terse instead of full prose. Technical content (code, paths,
 * commands, numbers, error strings) stays exact; only filler compresses.
 */
const CAVEMAN_BRIEF = [
  "Output style: caveman (full level). Respond terse like smart caveman. All technical substance stay, only fluff die.",
  "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not \"implement a solution for\").",
  "No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked — quote shortest decisive line. No causal arrows (→).",
  "Never invent abbreviations (cfg/impl/req/res/fn) — standard acronyms OK (DB/API/HTTP).",
  "ALWAYS keep code, file paths, commands, numbers, API names, and exact error strings verbatim. Code blocks unchanged.",
  "Pattern: [thing] [action] [reason]. [next step]. Not: \"Sure! I'd be happy to help. The issue you're experiencing is likely caused by...\" Yes: \"Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:\"",
  "Drop caveman for: security warnings, irreversible-action confirmations, or multi-step sequences where dropped conjunctions risk misread. Resume after.",
  "No self-reference — never name or announce the style.",
].join("\n");

/** Standing control-plane brief injected into each act-mode fleet turn. */
function controlBrief(name: string): string {
  return [
    `You are "${name}", one agent in ${getUserConfig().displayName}'s vidi fleet. You can coordinate with siblings and shared memory by running these with Bash (node is allowlisted):`,
    `  node ${VIDICTL} state                     — list sibling agents and their status`,
    `  node ${VIDICTL} recall [query]            — read shared fleet memory`,
    `  node ${VIDICTL} remember "<fact>"         — save a fact for siblings and your future turns`,
    `  node ${VIDICTL} tell <Name> "<task>"      — hand a task to a sibling agent`,
    `  node ${VIDICTL} spawn <claude|codex> [Name] — create a new sibling agent`,
    `  node ${VIDICTL} shell "<command>"         — start a long-running process (e.g. a dev server) in a separate managed terminal; keep THIS turn for reasoning and edits`,
    `  node ${VIDICTL} hands snapshot — compact numbered list of on-screen UI elements + a "generation" number (PREFER over screenshots: ~10x cheaper, deterministic). Then act by id: \`hands clickById <id> <generation>\` / \`hands typeInById <id> <generation> <text>\` (pass the generation from the SAME snapshot; a stale one is rejected — just re-snapshot). Fallbacks: \`hands clickElement <title>\`, \`hands type <text>\`, \`hands key <name>\`. Reusable routines: \`hands macro list|play <name>\`. Use GUI control ONLY when the task is explicitly about operating the screen; run \`hands health\` first.`,
    `Recall shared memory before starting a task, and remember key results so siblings and your future turns have them. You CANNOT spawn further agents (the control plane hard-refuses a spawn from a spawned agent) — do the work yourself or hand it to an existing sibling.`,
  ].join("\n");
}

interface State {
  agents: Map<string, AgentRuntime>;
  listeners: Set<(e: FleetEvent) => void>;
  loaded: boolean;
}

const state: State = ((globalThis as Record<string, any>).__vidiFleet ??= {
  agents: new Map(),
  listeners: new Set(),
  loaded: false,
});

function loadFromDisk() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(agentsFile(), "utf8"));
    if (Array.isArray(raw)) {
      for (const a of raw) {
        if (!a?.id || !a?.name) continue;
        // Only rehydrate agents whose thread still exists.
        if (!getThread(a.id)) continue;
        state.agents.set(a.id, {
          id: a.id,
          name: a.name,
          provider: a.provider ?? "claude",
          model: a.model ?? null,
          mode: a.mode === "act" ? "act" : "chat",
          status: "idle", // live state is never persisted
          createdAt: a.createdAt ?? Date.now(),
          lastActivity: a.createdAt ?? Date.now(),
          turns: 0,
          tokens: { input: 0, output: 0 },
          feed: [],
          // Trust a stored origin; infer one for a pre-migration row (item 4).
          origin: VALID_ORIGINS.has(a.origin) ? (a.origin as AgentOrigin) : inferLegacyOrigin(a.name),
          // Rehydrate depth; a legacy row without it is a user-spawned root (0).
          depth: typeof a.depth === "number" ? a.depth : 0,
        });
      }
    }
  } catch {
    /* no fleet yet */
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(agentsFile()), { recursive: true });
    // Only user-initiated agents are persisted (item 3): background
    // ("goal"/"system") agents are ephemeral per-run and are torn down when
    // their run ends, so they must never accrete in the on-disk registry (the
    // suitehealth → suitehealth2 → suitehealth3 pollution). This also self-heals
    // an already-polluted agents.json: the first persist after a load drops the
    // legacy background rows that loadFromDisk classified as goal/system.
    const rows = [...state.agents.values()]
      .filter((a) => isUserVisibleOrigin(a.origin))
      .map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        model: a.model,
        mode: a.mode,
        origin: a.origin,
        createdAt: a.createdAt,
        depth: a.depth,
      }));
    const tmp = `${agentsFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
    fs.renameSync(tmp, agentsFile());
  } catch {
    /* persistence best-effort; live state is the source of truth */
  }
}

function toPublic(a: AgentRuntime): AgentPublic {
  const { abort, ...rest } = a;
  return { ...rest, feed: a.feed.slice(-FEED_CAP) };
}

function emit(e: FleetEvent) {
  for (const cb of state.listeners) {
    try {
      cb(e);
    } catch {
      /* a broken listener must not break a turn */
    }
  }
}

function pushFeed(a: AgentRuntime, ev: FeedEvent) {
  a.feed.push(ev);
  if (a.feed.length > FEED_CAP) a.feed.splice(0, a.feed.length - FEED_CAP);
  a.lastActivity = ev.ts;
  emit({ kind: "feed", agentId: a.id, event: ev, status: a.status, origin: a.origin });
}

/**
 * Post a delegated turn's outcome back into the chat thread that spawned it,
 * then sever the link (one-shot — later Canvas prompts stay on the canvas).
 * The origin thread may have been deleted while the agent worked; in that
 * case the answer simply stays on the agent's own thread/card.
 */
/**
 * Build the plain-language origin-chat report for a failed turn (F3). The raw
 * provider/CLI message is classified through plainLanguageProviderError — it
 * never appears in the returned string, so no stderr/paths/flags reach the chat
 * or the Canvas feed. The agent name is kept. Exported + pure so the error
 * boundary is unit-testable without the (un-importable-under-node-test)
 * provider chain; the raw text is logged by the caller.
 */
export function fleetErrorReport(agentName: string, rawMessage: string | undefined | null): string {
  return `⚠️ **${agentName}** hit an error: ${plainLanguageProviderError(rawMessage)} Check the card on Canvas.`;
}

async function reportBackToOrigin(agent: AgentRuntime, reportText: string) {
  const originThreadId = agent.originThreadId;
  if (!originThreadId) return;
  agent.originThreadId = null;
  let originThread = null;
  try {
    originThread = await updateThread(originThreadId, (th) => {
      th.messages.push({ role: "assistant", text: reportText, ts: Date.now() });
    });
  } catch {
    /* a failed report must not fail the turn — the answer is on the card */
  }
  pushFeed(agent, {
    type: "system",
    ts: Date.now(),
    text: originThread
      ? "answer posted back to your chat"
      : "origin chat is gone — answer kept here",
  });
}

function pickName(explicit?: string): string {
  const taken = new Set([...state.agents.values()].map((a) => a.name.toLowerCase()));
  // An explicit caller-provided name always wins (letters-only, deduped) — the
  // preference only governs the DEFAULT name for a nameless spawn.
  if (explicit) {
    const clean = explicit.replace(/[^a-zA-Z]/g, "");
    if (clean) {
      const base = clean[0].toUpperCase() + clean.slice(1).toLowerCase();
      // Dedupe: two agents sharing a name would break voice addressing.
      if (!taken.has(base.toLowerCase())) return base;
      for (let i = 2; ; i++) {
        if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
      }
    }
  }
  // A3 — a nameless spawn draws the next UNUSED name from the user's preferred
  // stack ("unused" = not currently in agents.json / the live roster). The
  // preference is read live and already sanitized (an invalid stored value
  // yields the Kannada default). Fail-open: if reading the preference throws
  // for any reason, fall back to the legacy Mahabharata NAME_POOL so a spawn is
  // never blocked by config.
  let preferredStackNames: string[] = [];
  try {
    preferredStackNames = nameStackByIdOrDefault(getPreferredAgentNameStackId()).names.map(
      (entry) => entry.name
    );
  } catch {
    /* config unreadable — fall through to the legacy pool below */
  }
  const freeFromStack = preferredStackNames.find((n) => !taken.has(n.toLowerCase()));
  if (freeFromStack) return freeFromStack;
  // Preferred stack exhausted: WRAP within the same stack with a numeric suffix
  // ("Garuda" → "Garuda2") — the least-surprising fallback, keeping the chosen
  // theme's identity instead of jumping to an unthemed pool. Mirrors the exact
  // explicit-name collision behavior above. (Stacks have 6–10 names and the
  // fleet caps at 8, so this is a defensive edge, not the common path.)
  if (preferredStackNames.length > 0) {
    for (let i = 2; ; i++) {
      const wrapped = `${preferredStackNames[0]}${i}`;
      if (!taken.has(wrapped.toLowerCase())) return wrapped;
    }
  }
  // Only reached if the preference was totally unreadable: legacy pool, then a
  // generic suffix.
  const free = NAME_POOL.find((n) => !taken.has(n.toLowerCase()));
  if (free) return free;
  return `Agent-${state.agents.size + 1}`; // pool exhausted
}

export function listAgents(): AgentPublic[] {
  loadFromDisk();
  return [...state.agents.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toPublic);
}

/**
 * The Canvas-facing roster: ONLY user-initiated agents (origin "chat"/"manual").
 * Background ("goal"/"system") agents are excluded so they never render as panes
 * nor inflate the "N active" badge (item 1). listAgents() (all origins) is kept
 * for internal coordination callers — the control-plane `state` view and the
 * standing report — where an agent must still see its background siblings. */
export function listVisibleAgents(): AgentPublic[] {
  return listAgents().filter((a) => isUserVisibleOrigin(a.origin));
}

/**
 * Resolve an agent by spoken/typed name. Exact (normalized) match first;
 * then a UNIQUE long-prefix (q is a prefix of exactly one name, q>=4 chars)
 * for mild STT tolerance ("quil" -> "Quill"). Deliberately conservative: the
 * old fuzzy match (reversed prefix + edit-distance) hijacked ordinary
 * commands — "ask administrator to..." resolved to agent "Ada" — so a
 * too-loose match is a correctness bug, not a convenience.
 */
export function findByName(name: string): AgentPublic | null {
  loadFromDisk();
  const q = name.trim().toLowerCase();
  if (q.length < 2) return null;
  const all = [...state.agents.values()];
  const exact = all.find((a) => a.name.toLowerCase() === q);
  if (exact) return toPublic(exact);
  if (q.length >= 4) {
    const prefixed = all.filter((a) => a.name.toLowerCase().startsWith(q));
    if (prefixed.length === 1) return toPublic(prefixed[0]);
  }
  return null;
}

export function spawn(opts: {
  provider?: string;
  model?: string | null;
  name?: string;
  mode?: ThreadMode;
  /** Per-turn reasoning effort for this agent's runs. Delegation sets
   *  "high" on build-shaped tasks so model:"auto" resolves to
   *  opus+ultracode (lib/models.ts); unset = the router's default. */
  effort?: string;
  /** Chat thread that is delegating its next task to this agent — the
   *  answer is posted back there when the turn completes. Not persisted:
   *  an in-flight turn doesn't survive a restart, so the link can't either. */
  originThreadId?: string;
  /** The agent that requested this spawn (via the control plane / vidictl), if
   *  any. Used to enforce spawn depth (H10): a depth>=1 agent cannot spawn.
   *  Absent means a user/top-level spawn (depth 0). */
  parentAgentId?: string;
  /** Who initiated this spawn — governs Canvas visibility (see AgentOrigin).
   *  Defaults to "manual" (the +Spawn button / an unattributed caller); the
   *  chat-delegation, voice, goal-tick, and control-plane call sites pass their
   *  own origin explicitly. */
  origin?: AgentOrigin;
}): AgentPublic {
  loadFromDisk();
  // Spawn-depth mechanism (H10, was an advisory in the control brief). A
  // user/top-level spawn is depth 0. An agent-requested spawn (parentAgentId
  // set) is one deeper than its parent — but a parent already at depth >= 1 is
  // hard-refused, so a spawned agent can spawn at most... nothing: only the
  // user's depth-0 agents may spawn, and their children (depth 1) cannot. This
  // caps the tree at one level and stops fleet self-escalation.
  let depth = 0;
  if (opts.parentAgentId) {
    const parent = state.agents.get(opts.parentAgentId);
    // An unknown parent id is treated as a spawned agent trying to hide its
    // lineage — refuse rather than grant a depth-0 spawn.
    const parentDepth = parent ? parent.depth : 1;
    if (parentDepth >= 1) {
      throw new Error(
        `a spawned agent can't spawn further agents — ask ${getUserConfig().displayName} or the top-level assistant to spawn one`
      );
    }
    depth = parentDepth + 1;
  }
  if (state.agents.size >= MAX_AGENTS) {
    throw new Error(`fleet is full (${MAX_AGENTS} agents) — close one first`);
  }
  const provider = opts.provider === "codex" ? "codex" : "claude";
  // Codex ignores mode (read-only); claude fleet agents default to act so
  // they actually build. Autonomous runs stay Sonnet by policy.
  const mode: ThreadMode = provider === "codex" ? "chat" : opts.mode ?? "act";
  // Token-discipline default (lib/model-policy.ts): an un-flagged worker runs on
  // the CHEAP tier — sonnet (claude) / the cheapest gpt slug (codex). A caller
  // that KNOWS the task is build-shaped (chat delegation) passes model+effort
  // explicitly to escalate; only the unspecified fall-through lands here. The
  // shipped default is the policy; an install can override it via env /
  // data/user-config.json without touching source.
  const model = opts.model ?? workerModelFor(provider);
  const thread = createThread(provider, model, mode);
  const name = pickName(opts.name);
  const now = Date.now();
  const agent: AgentRuntime = {
    id: thread.id,
    name,
    provider,
    model,
    mode,
    // Un-flagged workers run at the policy's worker effort ("medium"); a
    // build-shaped delegation passes "high" explicitly to reach opus+ultracode.
    effort: opts.effort ?? workerEffort(),
    status: "idle",
    createdAt: now,
    lastActivity: now,
    turns: 0,
    tokens: { input: 0, output: 0 },
    feed: [
      { type: "system", ts: now, text: `${name} · ${provider} · ${mode} — ready` },
    ],
    originThreadId: opts.originThreadId ?? null,
    origin: opts.origin ?? "manual",
    depth,
  };
  state.agents.set(agent.id, agent);
  persist();
  emit({ kind: "spawn", agent: toPublic(agent) });
  return toPublic(agent);
}

/** Kick off a turn in the background; returns immediately. */
export function prompt(id: string, text: string): {
  ok: boolean;
  reason?: string;
  agent?: AgentPublic;
} {
  loadFromDisk();
  const agent = state.agents.get(id);
  if (!agent) return { ok: false, reason: "no such agent" };
  if (agent.status === "working") {
    return { ok: false, reason: `${agent.name} is still working on the last task`, agent: toPublic(agent) };
  }
  // Claim the working state SYNCHRONOUSLY, before any await, so a second
  // prompt() in the same tick (e.g. voice + a Canvas click) sees "working"
  // and is rejected — the guard would be defeated if this waited for
  // runTurn's first await. The AbortController is created here too so close()
  // can always abort the whole turn lifetime, including its async setup.
  agent.status = "working";
  agent.turns++;
  const abort = new AbortController();
  agent.abort = abort;
  emit({ kind: "update", agent: toPublic(agent) });
  void runTurn(agent, text, abort);
  return { ok: true, agent: toPublic(agent) };
}

async function runTurn(agent: AgentRuntime, text: string, abort: AbortController) {
  // Lazy import: keeps the manager's pure fleet logic loadable without the
  // provider chain (unit tests), and running a real turn needs a live
  // subscription anyway (covered by the smoke test).
  let errored = false;
  // The final assistant text of this turn, for the transition summary.
  let lastFullText = "";
  try {
    const { getProvider } = await import("../providers/index.ts");
    // close() may have fired during the import: bail if the agent was removed
    // or this turn was aborted before it started.
    if (state.agents.get(agent.id) !== agent || abort.signal.aborted) return;
    const provider = getProvider(agent.provider);
    if (!provider) {
      errored = true;
      agent.status = "error";
      pushFeed(agent, { type: "error", ts: Date.now(), text: `unknown provider ${agent.provider}` });
      return;
    }
    pushFeed(agent, { type: "user", ts: Date.now(), text });

    await withTurnLock(agent.id, async () => {
      // Persist the user message inside the turn lock so nothing interleaves
      // the transcript, and re-read to resume the latest provider session.
      await updateThread(agent.id, (th) => {
        if (th.messages.length === 0) th.title = `${agent.name}: ${text}`.slice(0, 48);
        th.messages.push({ role: "user", text, ts: Date.now() });
      });
      const fresh = getThread(agent.id);
      // Every fleet agent (chat or act) talks caveman. Act-mode agents also
      // get the control-plane brief + a shared-memory digest each turn so
      // they can coordinate and start with context.
      let extraSystemText: string = CAVEMAN_BRIEF;
      if (agent.mode === "act") {
        const digest = memoryDigest();
        extraSystemText += `\n\n${controlBrief(agent.name)}`;
        if (digest) extraSystemText += `\n\n${digest}`;
      }
      // FIX 1 (uniform): an agent's model/mode/effort are fixed for its life, so
      // the fingerprint stays constant and resume behaves as before; the gate is
      // applied here too for uniformity across every session-feeding call site.
      const agentFp = computeFingerprint({
        provider: fresh?.provider ?? "claude",
        model: agent.model,
        effort: agent.effort ?? undefined,
        mode: agent.mode,
      });
      const resumeAgent = shouldResumeSession({
        priorProviderSessionId: fresh?.providerSessionId ?? null,
        storedFingerprint: fresh?.sessionFingerprint,
        current: agentFp,
      });
      const gen = provider.sendMessage({
        threadId: agent.id,
        priorProviderSessionId: resumeAgent ? fresh?.providerSessionId ?? null : null,
        sessionAccountId: fresh?.sessionAccountId ?? null,
        userMessage: text,
        model: agent.model,
        mode: agent.mode,
        effort: agent.effort ?? undefined,
        signal: abort.signal,
        extraSystemText,
        // H10: stamp this agent's identity + depth into the CLI child env so a
        // vidictl spawn it runs identifies its caller — which lets the control
        // route enforce spawn depth (a depth>=1 agent's spawn is refused).
        childEnv: { VIDI_AGENT_ID: agent.id, VIDI_AGENT_DEPTH: String(agent.depth) },
      });
      for await (const ev of gen) {
        if (ev.type === "delta") {
          pushFeed(agent, { type: "delta", ts: Date.now(), text: ev.text });
        } else if (ev.type === "tool") {
          pushFeed(agent, { type: "tool", ts: Date.now(), tool: ev.tool, summary: ev.summary });
          if (agent.mode === "act") {
            appendJournal({ ts: Date.now(), threadId: agent.id, tool: ev.tool, summary: ev.summary });
          }
        } else if (ev.type === "done") {
          lastFullText = ev.fullText || lastFullText;
          await updateThread(agent.id, (th) => {
            th.providerSessionId = ev.providerSessionId ?? th.providerSessionId;
            if (ev.accountId !== undefined) th.sessionAccountId = ev.accountId;
            // Stamp the settings this agent's session was created with (agent.*,
            // not th.* — the agent thread may not mirror them).
            th.sessionFingerprint = agentFp;
            th.messages.push({ role: "assistant", text: ev.fullText, ts: Date.now() });
          });
          if (ev.usage) {
            agent.tokens.input += ev.usage.inputTokens ?? 0;
            agent.tokens.output += ev.usage.outputTokens ?? 0;
          }
          pushFeed(agent, { type: "done", ts: Date.now(), text: ev.fullText });
          // H9: a sibling agent's raw output is untrusted cross-agent content
          // when it lands in the origin (user-facing) thread — fence it as an
          // <agent-report> data block so an injected "ignore previous / do X"
          // line in the agent's answer can't drive the origin turn.
          await reportBackToOrigin(
            agent,
            `✅ **${agent.name}** done. Answer:\n\n` +
              fenceUntrusted(`${agent.name} agent report`, ev.fullText)
          );
        } else if (ev.type === "error") {
          errored = true;
          agent.status = "error";
          if (ev.resetProviderSession) {
            await updateThread(agent.id, (th) => {
              th.providerSessionId = null;
            });
          }
          // An errored turn still burned tokens (the provider ledgers them);
          // reflect that on the card too.
          if (ev.usage) {
            agent.tokens.input += ev.usage.inputTokens ?? 0;
            agent.tokens.output += ev.usage.outputTokens ?? 0;
          }
          // Raw provider/CLI detail (stderr, flags, paths) goes to the log
          // only; the Canvas feed and the origin chat get a plain-language line
          // (F3 — same boundary as chat/voice-turn). The agent name is kept.
          console.error(`[fleet] ${agent.name} provider error:`, ev.message);
          recordProviderDiag(ev.message); // observe-only local ledger
          pushFeed(agent, {
            type: "error",
            ts: Date.now(),
            text: plainLanguageProviderError(ev.message),
          });
          // The delegating chat must not wait forever on a dead turn.
          await reportBackToOrigin(agent, fleetErrorReport(agent.name, ev.message));
        }
      }
    });
    if (!errored) agent.status = "idle";
  } catch (e: any) {
    errored = true;
    agent.status = "error";
    // Raw exception detail to the log; feed + origin chat get the friendly line.
    console.error(`[fleet] ${agent.name} turn threw:`, e);
    recordProviderDiag(e?.message); // observe-only local ledger
    pushFeed(agent, {
      type: "error",
      ts: Date.now(),
      text: plainLanguageProviderError(e?.message),
    });
    await reportBackToOrigin(agent, fleetErrorReport(agent.name, e?.message));
  } finally {
    // Only clear if this run still owns the slot (close() may have replaced it).
    if (agent.abort === abort) agent.abort = undefined;
    if (state.agents.get(agent.id) === agent) {
      // Durable transition sink: record the working→idle / working→error
      // transition for the ops agent.finished producer. Guard on a settled
      // status so the aborted-before-start bailout (returns while status is
      // still "working") doesn't log a phantom completion. One line per turn.
      if (agent.status === "idle" || agent.status === "error") {
        recordTransition(agent, agent.status, lastFullText);
      }
      emit({ kind: "update", agent: toPublic(agent) });
    }
  }
}

export function close(id: string): boolean {
  loadFromDisk();
  const agent = state.agents.get(id);
  if (!agent) return false;
  try {
    agent.abort?.abort();
  } catch {
    /* nothing running */
  }
  state.agents.delete(id);
  persist();
  emit({ kind: "close", agent: toPublic(agent) });
  return true;
}

export function subscribe(cb: (e: FleetEvent) => void): () => void {
  state.listeners.add(cb);
  return () => state.listeners.delete(cb);
}

/** Push a system note onto an agent's feed (used by the loop controller). */
export function pushSystemNote(id: string, text: string): void {
  const agent = state.agents.get(id);
  if (agent) pushFeed(agent, { type: "system", ts: Date.now(), text });
}

/** Abort an agent's in-flight turn (SIGKILLs the CLI) WITHOUT removing the
 *  agent — used when a loop times out, so a runaway turn can't outlive it. */
export function abortAgentTurn(id: string): boolean {
  const agent = state.agents.get(id);
  if (!agent?.abort) return false;
  try {
    agent.abort.abort();
    return true;
  } catch {
    return false;
  }
}

/** Read an agent's current runtime snapshot (status + tokens) for controllers. */
export function getAgent(id: string): AgentPublic | null {
  loadFromDisk();
  const a = state.agents.get(id);
  return a ? toPublic(a) : null;
}

// Exported for unit testing the durable transition sink without spawning a real
// provider turn (the provider chain isn't importable under `node --test`). This
// is the EXACT function runTurn's finally-block calls on working→idle/error.
export const _internal = {
  recordTransition: (
    input: { id: string; name: string },
    status: "idle" | "error",
    finalText?: string
  ) => recordTransition(input as AgentRuntime, status, finalText),
  // The item-4 migration rule for legacy (pre-origin) agents.json rows.
  inferLegacyOrigin,
};
