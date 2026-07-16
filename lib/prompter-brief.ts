/**
 * The Build Brief shape and its PURE transforms — coercion, rendering, section
 * editing, and diffing. No node built-ins, so this module is safe to import
 * from client components (components/prompter/*). The persistence + model
 * pieces live in lib/prompter.ts, which re-exports everything here so server
 * callers and tests can keep importing from one place.
 */

export interface Brief {
  title: string;
  oneSentence: string;
  who: string;
  pages: string[];
  mustHave: string[];
  later: string[];
  lookAndFeel: string;
  youWillProvide: string[];
  notDoing: string[];
  doneMeans: string;
}

export type BriefSectionKey = keyof Brief;

export interface BriefSectionSpec {
  key: BriefSectionKey;
  /** Heading shown to the customer (fixed section names). */
  label: string;
  kind: "text" | "list";
}

/** The fixed brief sections, in render order. */
export const BRIEF_SECTIONS: readonly BriefSectionSpec[] = [
  { key: "title", label: "Title", kind: "text" },
  { key: "oneSentence", label: "In one sentence", kind: "text" },
  { key: "who", label: "Who it is for", kind: "text" },
  { key: "pages", label: "Pages", kind: "list" },
  { key: "mustHave", label: "Must have", kind: "list" },
  { key: "later", label: "Later", kind: "list" },
  { key: "lookAndFeel", label: "Look and feel", kind: "text" },
  { key: "youWillProvide", label: "You will provide", kind: "list" },
  { key: "notDoing", label: "Not doing", kind: "list" },
  { key: "doneMeans", label: "Done means", kind: "text" },
];

export function sectionSpec(key: BriefSectionKey): BriefSectionSpec {
  const spec = BRIEF_SECTIONS.find((s) => s.key === key);
  if (!spec) throw new Error(`unknown brief section: ${key}`);
  return spec;
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string")
    return v
      .split("\n")
      .map((s) => s.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  return [];
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

/** Coerce raw (model JSON or a UI edit) into a well-formed Brief. Never throws
 *  — a missing field becomes empty, so a half-formed model reply still yields
 *  an editable brief. */
export function coerceBrief(raw: unknown): Brief {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    title: asText(o.title) || "Your project",
    oneSentence: asText(o.oneSentence),
    who: asText(o.who),
    pages: asList(o.pages),
    mustHave: asList(o.mustHave),
    later: asList(o.later),
    lookAndFeel: asText(o.lookAndFeel),
    youWillProvide: asList(o.youWillProvide),
    notDoing: asList(o.notDoing),
    doneMeans: asText(o.doneMeans),
  };
}

/** The value of one section rendered as a plain string (for before/after
 *  displays and edit fields). */
export function renderSectionValue(brief: Brief, key: BriefSectionKey): string {
  const spec = sectionSpec(key);
  const v = brief[key];
  return spec.kind === "list" ? (v as string[]).join("\n") : String(v);
}

/** Set one section from a raw UI string, coerced by its kind. Returns a new
 *  brief (immutable). */
export function setSection(brief: Brief, key: BriefSectionKey, value: string): Brief {
  const spec = sectionSpec(key);
  return { ...brief, [key]: spec.kind === "list" ? asList(value) : asText(value) };
}

/** Render the brief as fixed-section markdown — what BRIEF.md holds and what
 *  seeds the act-mode build. */
export function renderBriefMarkdown(brief: Brief): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "_(nothing yet)_";
  const text = (s: string) => (s.trim() ? s.trim() : "_(nothing yet)_");
  return [
    `# ${brief.title}`,
    ``,
    `## In one sentence`,
    text(brief.oneSentence),
    ``,
    `## Who it is for`,
    text(brief.who),
    ``,
    `## Pages`,
    list(brief.pages),
    ``,
    `## Must have`,
    list(brief.mustHave),
    ``,
    `## Later`,
    list(brief.later),
    ``,
    `## Look and feel`,
    text(brief.lookAndFeel),
    ``,
    `## You will provide`,
    list(brief.youWillProvide),
    ``,
    `## Not doing`,
    list(brief.notDoing),
    ``,
    `## Done means`,
    text(brief.doneMeans),
    ``,
  ].join("\n");
}

export interface SectionChange {
  key: BriefSectionKey;
  label: string;
  before: string;
  after: string;
}

/** Pure per-section diff — only the sections that actually changed, each with a
 *  before/after string the UI shows the customer. */
export function diffBriefs(before: Brief, after: Brief): SectionChange[] {
  const changes: SectionChange[] = [];
  for (const spec of BRIEF_SECTIONS) {
    const b = renderSectionValue(before, spec.key);
    const a = renderSectionValue(after, spec.key);
    if (b !== a) changes.push({ key: spec.key, label: spec.label, before: b, after: a });
  }
  return changes;
}

/**
 * The opening user content that seeds the act-mode build thread. Plain
 * instruction + the git rules (branch→PR→approval-before-push, one repo per
 * plan, worktrees for helpers) + the full brief — the brief IS the task.
 * Reuses the ordinary thread turn path (POST /api/chat).
 *
 * The git rules are stated to the agent HERE (not just relied on from the act
 * rails) so the plan build follows the standard workflow: the branch/no-push
 * behavior the agent already showed in testing, made explicit and consistent.
 * The act-mode confirm gate still independently forces a yes before any push,
 * so this is belt-and-braces, never a way around approval.
 */
/** Local slug for the build-seed folder/branch names (no import cycle with
 *  prompter.ts, which imports this module). Mirrors slugify() there. */
function slugifyTitle(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "my-project";
}

export function briefBuildSeed(brief: Brief): string {
  const slug = slugifyTitle(brief.title);
  return (
    `Please build this. Here is the plan we agreed on. Follow it closely, and ` +
    `check in with me before doing anything it does not cover.\n\n` +
    `How to build it (please follow these git rules exactly):\n` +
    `- Put this plan in its OWN new project folder and its own git repo — one ` +
    `repo per plan. Suggested folder name: "${slug}". Never build into an ` +
    `existing project.\n` +
    `- Do all the work on a NEW feature branch (e.g. "build/${slug}"), never ` +
    `on main or master. Commit as you go with clear messages.\n` +
    `- If you send helpers out to work in parallel, each helper works in its ` +
    `own git worktree on its own branch, then their work merges back.\n` +
    `- When it's built and committed, create a PRIVATE GitHub repo for it and ` +
    `push the branch — but STOP and ask me for a clear yes BEFORE you push or ` +
    `open a pull request. Never push to main/master directly. Nothing leaves ` +
    `this Mac until I approve it.\n\n` +
    renderBriefMarkdown(brief)
  );
}
