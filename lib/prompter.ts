import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { workspacePath } from "./workspace.ts";
import { getModelPolicy } from "./model-policy.ts";
import type { Effort } from "./models.ts";
import {
  BRIEF_SECTIONS,
  coerceBrief,
  diffBriefs,
  renderBriefMarkdown,
  renderSectionValue,
  sectionSpec,
  setSection,
  type Brief,
  type BriefSectionKey,
  type SectionChange,
} from "./prompter-brief.ts";

// Re-export the pure brief surface so server callers and tests keep importing
// everything from lib/prompter. Client components import the runtime pieces
// straight from lib/prompter-brief (which has no node built-ins) to stay out of
// the browser bundle's way.
export {
  BRIEF_SECTIONS,
  coerceBrief,
  diffBriefs,
  renderBriefMarkdown,
  renderSectionValue,
  setSection,
  briefBuildSeed,
} from "./prompter-brief.ts";
export type { Brief, BriefSectionKey, BriefSectionSpec, SectionChange } from "./prompter-brief.ts";

/**
 * Prompter — turns a non-technical customer's scattered ideas into a readable,
 * editable Build Brief that then seeds Vidi's act-mode build.
 *
 * Decision of record (2026-07-11): the customer-facing artifact is a BRIEF in
 * their own words — approvable and editable — NEVER a raw mega-prompt. This
 * module is the pure engine (state machine, synthesis mapping, persistence,
 * amendment diffing); the React surface (components/prompter/*) and the API
 * routes (app/api/prompter/*) are thin shells over it.
 *
 * Model tiers (per the shipped token-discipline policy, lib/model-policy.ts):
 *   - WORKER tier drives the guided questions / adaptive follow-ups (cheap,
 *     conversational).
 *   - DEEP tier drives brief synthesis and amendment synthesis (this is
 *     planning — the deliberate work that earns opus+high).
 * resolveTierModel() is the single seam both the routes and the tests read, so
 * "questions ran on worker, synthesis ran on deep" is asserted, not assumed.
 */

// ── Model seam ──────────────────────────────────────────────────────────────

export type Tier = "worker" | "deep";

/**
 * The model + effort a given tier runs on, resolved live from the install's
 * token-discipline policy. WORKER → the fleet worker model (sonnet by default)
 * at worker effort; DEEP → the deep/build model ("auto" → the router resolves
 * opus) at deep effort ("high"). This is the seam tests assert against.
 */
export function resolveTierModel(tier: Tier): { model: string; effort: Effort } {
  const p = getModelPolicy();
  return tier === "deep"
    ? { model: p.deepModel, effort: p.deepEffort }
    : { model: p.workerModelClaude, effort: p.workerEffort };
}

/**
 * A one-shot model call, tagged with the tier it must run on. The default
 * implementation (defaultTierRun) wraps the claude provider; tests inject a
 * mock that records the tier and returns canned output, so no CLI is needed.
 */
export interface TierRun {
  (args: { tier: Tier; system: string; user: string }): Promise<string>;
}

/**
 * Provider-backed default runner. Used only by the routes (never in tests). It
 * resolves the tier's model/effort from policy and runs one plan-mode turn on
 * the claude CLI, returning the full text. Imported lazily so the pure engine
 * (and its tests) never pulls the provider chain.
 */
export const defaultTierRun: TierRun = async ({ tier, system, user }) => {
  const { model, effort } = resolveTierModel(tier);
  // Deliberately the RAW provider, not getProvider("claude"): this internal
  // prompter helper bypasses the circuit breaker on purpose so its own failures
  // neither trip nor are gated by the user-facing chat breaker.
  const { claudeProvider } = await import("./providers/claude.ts");
  let full = "";
  for await (const ev of claudeProvider.sendMessage({
    threadId: crypto.randomUUID(), // throwaway — this turn never touches the store
    userMessage: user,
    extraSystemText: system,
    model,
    effort,
    mode: "plan",
  })) {
    if (ev.type === "delta") full += ev.text;
    else if (ev.type === "done") full = ev.fullText || full;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return full.trim();
};

// ── Guided question flow (state machine) ────────────────────────────────────

export type PrompterTopic =
  | "idea"
  | "audience"
  | "pages"
  | "mustHave"
  | "later"
  | "lookAndFeel"
  | "content"
  | "done";

export interface PrompterQuestion {
  topic: PrompterTopic;
  /** Customer-facing question text (plain words, no jargon). */
  question: string;
  /** Concrete choice chips with plain descriptors — tap-to-answer. */
  chips: string[];
  /** Free text is always welcome on top of the chips. */
  allowFreeText: true;
}

export interface PrompterAnswer {
  topic: PrompterTopic;
  chosenChips?: string[];
  text?: string;
}

export interface PrompterState {
  answers: PrompterAnswer[];
  /** Topics that have a recorded answer, in the order they were answered. */
  askedTopics: PrompterTopic[];
  status: "asking" | "ready";
}

/** The base question bank. Order is the ask order; 8 topics keeps a run inside
 *  the 6-10 band. Copy is the customer's words — no jargon. */
const QUESTION_BANK: Record<PrompterTopic, PrompterQuestion> = {
  idea: {
    topic: "idea",
    question:
      "In your own words, what do you want to make? Throw down every idea you have. Nothing is too messy.",
    chips: [
      "A shop to sell things",
      "A place to show my work",
      "A booking or sign-up page",
      "A community or group space",
      "I am still figuring it out",
    ],
    allowFreeText: true,
  },
  audience: {
    topic: "audience",
    question: "Who is this for?",
    chips: [
      "Customers buying from me",
      "Friends and family",
      "My local community",
      "People in my line of work",
      "Anyone on the internet",
    ],
    allowFreeText: true,
  },
  pages: {
    topic: "pages",
    question:
      "What are the main parts people will see? Think three to five pages or sections.",
    chips: [
      "Home or welcome",
      "About me or us",
      "Shop or products",
      "Contact or booking",
      "Photo gallery",
    ],
    allowFreeText: true,
  },
  mustHave: {
    topic: "mustHave",
    question: "What has to be there on day one for this to feel done?",
    chips: [
      "Take payments",
      "Collect sign-ups",
      "Show a photo gallery",
      "A contact form",
      "A calendar or booking",
    ],
    allowFreeText: true,
  },
  later: {
    topic: "later",
    question: "What would be nice to add later, but can wait?",
    chips: [
      "Accounts and logins",
      "A blog or news",
      "Reviews or ratings",
      "Email newsletters",
      "Nothing comes to mind",
    ],
    allowFreeText: true,
  },
  lookAndFeel: {
    topic: "lookAndFeel",
    question: "How should it feel to look at?",
    chips: [
      "Clean and simple",
      "Warm and friendly",
      "Bold and colorful",
      "Calm and elegant",
      "Playful and fun",
    ],
    allowFreeText: true,
  },
  content: {
    topic: "content",
    question: "What do you already have that we can use? Words, photos, a logo?",
    chips: [
      "I have photos",
      "I have written text",
      "I have a logo",
      "I have a bit of everything",
      "I have nothing yet",
    ],
    allowFreeText: true,
  },
  done: {
    topic: "done",
    question: "How will you know it is finished and working the way you want?",
    chips: [
      "People can buy or book",
      "People can reach me",
      "It looks the way I pictured",
      "My photos are all up",
      "I can share the link proudly",
    ],
    allowFreeText: true,
  },
};

/** Ask order. */
export const PROMPTER_TOPICS: PrompterTopic[] = [
  "idea",
  "audience",
  "pages",
  "mustHave",
  "later",
  "lookAndFeel",
  "content",
  "done",
];

/** The minimum a brief needs before it can be synthesized. "later" and
 *  "content" enrich but never block. */
export const REQUIRED_TOPICS: PrompterTopic[] = [
  "idea",
  "audience",
  "pages",
  "mustHave",
  "lookAndFeel",
  "done",
];

export function initialState(): PrompterState {
  return { answers: [], askedTopics: [], status: "asking" };
}

/** The opening question — always the free-idea dump. */
export function firstQuestion(): PrompterQuestion {
  return QUESTION_BANK.idea;
}

function answerIsReal(a: PrompterAnswer): boolean {
  return Boolean((a.chosenChips && a.chosenChips.length) || (a.text && a.text.trim()));
}

/** Fold one answer into the state (immutably). A blank answer still advances
 *  the flow (the customer skipped a topic) but is not recorded as content. */
export function recordAnswer(state: PrompterState, answer: PrompterAnswer): PrompterState {
  const askedTopics = state.askedTopics.includes(answer.topic)
    ? state.askedTopics
    : [...state.askedTopics, answer.topic];
  const answers = answerIsReal(answer)
    ? [...state.answers.filter((a) => a.topic !== answer.topic), answer]
    : state.answers.filter((a) => a.topic !== answer.topic);
  const next: PrompterState = { answers, askedTopics, status: "asking" };
  next.status = isReady(next) && nextQuestion(next) === null ? "ready" : "asking";
  return next;
}

/** The next base question to ask, or null when every topic has been put to the
 *  customer. */
export function nextQuestion(state: PrompterState): PrompterQuestion | null {
  const next = PROMPTER_TOPICS.find((t) => !state.askedTopics.includes(t));
  return next ? QUESTION_BANK[next] : null;
}

/** Enough answered to synthesize a brief? */
export function isReady(state: PrompterState): boolean {
  const answered = new Set(state.answers.map((a) => a.topic));
  return REQUIRED_TOPICS.every((t) => answered.has(t));
}

/** Render the answers so far as a plain block for the model. */
export function answersToPrompt(state: PrompterState): string {
  return state.answers
    .map((a) => {
      const chips = a.chosenChips?.length ? a.chosenChips.join(", ") : "";
      const text = a.text?.trim() ?? "";
      const parts = [chips, text].filter(Boolean).join(" — ");
      return `${QUESTION_BANK[a.topic].question}\n${parts}`;
    })
    .join("\n\n");
}

const FOLLOWUP_SYSTEM =
  "You help a non-technical person plan a website or app. Given their answers " +
  "so far, ask ONE short, plain-language follow-up question that fills the " +
  "biggest gap. No jargon, no technical words. If nothing needs clarifying, " +
  'reply with exactly "NONE".';

/**
 * Adaptive clarifier on the WORKER tier — one plain follow-up question given
 * what the customer has said, or null when nothing needs clarifying. Runs on
 * the worker tier (cheap conversational work) per the token-discipline policy.
 */
export async function generateFollowUp(
  state: PrompterState,
  run: TierRun
): Promise<string | null> {
  const out = await run({
    tier: "worker",
    system: FOLLOWUP_SYSTEM,
    user: answersToPrompt(state),
  });
  const trimmed = out.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return null;
  return trimmed;
}

const ADAPT_SYSTEM =
  "You help a non-technical person plan a website or app. Reword the given " +
  "question so it fits what they have already told you, staying warm and " +
  "plain (no jargon). Keep it to one sentence. Reply with ONLY the reworded " +
  "question, or the original if no change helps.";

/**
 * Reword a base question to the customer's prior answers, on the WORKER tier.
 * Falls back to the base question on any empty/failed run, so the flow is never
 * blocked by the model.
 */
export async function adaptQuestion(
  base: PrompterQuestion,
  state: PrompterState,
  run: TierRun
): Promise<PrompterQuestion> {
  if (state.answers.length === 0) return base;
  try {
    const reworded = (
      await run({
        tier: "worker",
        system: ADAPT_SYSTEM,
        user: `Question: ${base.question}\n\nWhat they have told you:\n${answersToPrompt(state)}`,
      })
    ).trim();
    if (reworded) return { ...base, question: reworded };
  } catch {
    /* fall through to the base question */
  }
  return base;
}

// ── Synthesis (DEEP tier) ───────────────────────────────────────────────────

const SYNTH_SYSTEM =
  "You turn a non-technical person's scattered notes into a clear plan for a " +
  "website or app, written in THEIR words — warm, plain, no jargon. Reply with " +
  "ONLY a JSON object with these keys: title (string), oneSentence (string), " +
  "who (string), pages (array of strings), mustHave (array of strings), later " +
  "(array of strings), lookAndFeel (string), youWillProvide (array of strings), " +
  "notDoing (array of strings), doneMeans (string). Keep each item short and in " +
  "everyday language. Do not invent features they did not mention.";

/** Pull the first JSON object out of a model reply that may be wrapped in prose
 *  or a code fence. */
function extractJson(out: string): unknown {
  const fenced = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : out;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** A last-resort brief built straight from the answers, so synthesis never hard
 *  fails even if the model returns junk. */
function fallbackBrief(state: PrompterState): Brief {
  const find = (t: PrompterTopic) => state.answers.find((a) => a.topic === t);
  const val = (t: PrompterTopic) => {
    const a = find(t);
    if (!a) return "";
    return [a.chosenChips?.join(", "), a.text?.trim()].filter(Boolean).join(". ");
  };
  const listVal = (t: PrompterTopic) => {
    const a = find(t);
    if (!a) return [];
    return [...(a.chosenChips ?? []), ...(a.text ? [a.text.trim()] : [])].filter(Boolean);
  };
  return coerceBrief({
    title: "Your project",
    oneSentence: val("idea"),
    who: val("audience"),
    pages: listVal("pages"),
    mustHave: listVal("mustHave"),
    later: listVal("later"),
    lookAndFeel: val("lookAndFeel"),
    youWillProvide: listVal("content"),
    notDoing: [],
    doneMeans: val("done"),
  });
}

/**
 * Synthesize the Build Brief from the answers, on the DEEP tier (planning work).
 * Defensive: a malformed model reply falls back to a brief built directly from
 * the answers, so the customer always gets something editable.
 */
export async function synthesizeBrief(state: PrompterState, run: TierRun): Promise<Brief> {
  const out = await run({
    tier: "deep",
    system: SYNTH_SYSTEM,
    user: answersToPrompt(state),
  });
  try {
    return coerceBrief(extractJson(out));
  } catch {
    return fallbackBrief(state);
  }
}

// ── Persistence (workspace.ts conventions) ──────────────────────────────────

// INTEGRATION: once PR #69's lib/memory-wiki.ts is on master, saveBrief() should
// also copy/wikilink the rendered BRIEF.md into the memory wiki (a project note
// under the customer's projects space) so the brief is searchable brain content,
// not just a loose file. Deliberately deferred — that module is not yet on
// master and is another agent's file; wire it here when it lands.

/**
 * Where built projects live. Each project is a slugged directory holding
 * BRIEF.md (the readable brief), brief.json (the structured source of truth),
 * and BRIEF-HISTORY.md (a dated changelog per revision). Under the workspace
 * root by convention; VIDI_PROJECTS_ROOT overrides for tests / relocation.
 */
export function projectsRoot(): string {
  const override = process.env.VIDI_PROJECTS_ROOT;
  if (override && override.trim()) return path.resolve(override.trim());
  return workspacePath("vidi-projects");
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "project";
}

export function projectDir(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("bad project slug");
  return path.join(projectsRoot(), slug);
}

export interface StoredBrief {
  slug: string;
  brief: Brief;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface BriefFile extends StoredBrief {
  /** Dated changelog entries, newest last (also mirrored to BRIEF-HISTORY.md). */
  history: { version: number; at: number; reason: string }[];
}

function briefJsonPath(slug: string): string {
  return path.join(projectDir(slug), "brief.json");
}

function readBriefFile(slug: string): BriefFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(briefJsonPath(slug), "utf8"));
    return {
      slug,
      brief: coerceBrief(parsed.brief),
      version: Number(parsed.version) || 1,
      createdAt: Number(parsed.createdAt) || Date.now(),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return null;
  }
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Write a brief to its project folder — brief.json (source of truth), BRIEF.md
 * (readable), and an appended BRIEF-HISTORY.md changelog. A new project starts
 * at v1; every re-save bumps the version and appends a dated history entry, so
 * "every edit re-saves + appends history" holds for edits and amendments alike.
 */
export function saveBrief(brief: Brief, opts: { reason: string; slug?: string }): StoredBrief {
  const slug = opts.slug ?? slugify(brief.title);
  const existing = readBriefFile(slug);
  const now = Date.now();
  const version = existing ? existing.version + 1 : 1;
  const createdAt = existing?.createdAt ?? now;
  const history = [
    ...(existing?.history ?? []),
    { version, at: now, reason: opts.reason },
  ];

  const dir = projectDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const file: BriefFile = { slug, brief, version, createdAt, updatedAt: now, history };
  fs.writeFileSync(briefJsonPath(slug), JSON.stringify(file, null, 2));
  fs.writeFileSync(path.join(dir, "BRIEF.md"), renderBriefMarkdown(brief));
  fs.appendFileSync(
    path.join(dir, "BRIEF-HISTORY.md"),
    `## v${version} (${isoDate(now)})\n${opts.reason}\n\n`
  );

  return { slug, brief, version, createdAt, updatedAt: now };
}

export function loadBrief(slug: string): StoredBrief | null {
  const f = readBriefFile(slug);
  if (!f) return null;
  return { slug: f.slug, brief: f.brief, version: f.version, createdAt: f.createdAt, updatedAt: f.updatedAt };
}

/**
 * Delete one saved plan (its whole project dir under the projects root). Returns
 * true if it existed. The slug is validated by projectDir (throws on a bad
 * slug), so this can only ever remove a directory INSIDE the projects root.
 */
export function deleteBrief(slug: string): boolean {
  const dir = projectDir(slug); // validates the slug shape
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function listBriefs(): { slug: string; title: string; version: number; updatedAt: number }[] {
  const root = projectsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: { slug: string; title: string; version: number; updatedAt: number }[] = [];
  for (const slug of entries) {
    const f = readBriefFile(slug);
    if (f) out.push({ slug: f.slug, title: f.brief.title, version: f.version, updatedAt: f.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Edit one section from a raw UI string and re-save (bumping the version and
 * appending history). Returns the new stored brief, or null if the slug is
 * unknown.
 */
export function editBriefSection(
  slug: string,
  key: BriefSectionKey,
  value: string
): StoredBrief | null {
  const cur = loadBrief(slug);
  if (!cur) return null;
  const brief = setSection(cur.brief, key, value);
  return saveBrief(brief, { reason: `Edited ${sectionSpec(key).label}`, slug });
}

// ── Amendment (DEEP tier) ───────────────────────────────────────────────────

export interface AmendmentProposal {
  changes: SectionChange[];
  /** The full proposed brief (customer approves, then it is saved as v(n+1)). */
  proposedBrief: Brief;
  fromVersion: number;
  toVersion: number;
}

const AMEND_SYSTEM =
  "You are updating an existing plan for a non-technical person's website or " +
  "app because they have shared more ideas. Keep everything that still fits and " +
  "fold in the new ideas, staying in their words with no jargon. Reply with " +
  "ONLY the full updated JSON object (same keys as before: title, oneSentence, " +
  "who, pages, mustHave, later, lookAndFeel, youWillProvide, notDoing, " +
  "doneMeans). Do not drop things they did not ask to remove.";

/**
 * Map a fresh dump of scattered ideas onto the existing brief, on the DEEP tier,
 * and return a before/after proposal (only the changed sections). The customer
 * approves, then applyAmendment() saves it as the next version.
 */
export async function proposeAmendment(
  current: StoredBrief,
  ideas: string,
  run: TierRun
): Promise<AmendmentProposal> {
  const out = await run({
    tier: "deep",
    system: AMEND_SYSTEM,
    user: `Current plan:\n${renderBriefMarkdown(current.brief)}\n\nTheir new ideas:\n${ideas.trim()}`,
  });
  let proposedBrief: Brief;
  try {
    proposedBrief = coerceBrief(extractJson(out));
  } catch {
    proposedBrief = current.brief; // no confident change — propose nothing
  }
  return {
    changes: diffBriefs(current.brief, proposedBrief),
    proposedBrief,
    fromVersion: current.version,
    toVersion: current.version + 1,
  };
}

/** Persist an approved amendment as the next version. */
export function applyAmendment(slug: string, proposedBrief: Brief): StoredBrief {
  return saveBrief(proposedBrief, { reason: "Added your new ideas", slug });
}
