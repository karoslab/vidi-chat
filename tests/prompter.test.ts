import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

/**
 * Prompter engine tests. Isolate cwd to a fresh temp dir (so getModelPolicy
 * sees a clean "fresh install" default) and point VIDI_PROJECTS_ROOT at a temp
 * dir before importing, so brief persistence never touches the real workspace.
 * The provider is never called — every model-driven function takes a TierRun,
 * and the tests inject a mock that records the tier and returns canned output.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-prompter-cwd-")));
for (const k of ["VIDI_DEEP_MODEL", "VIDI_DEEP_EFFORT", "VIDI_WORKER_MODEL", "VIDI_WORKER_EFFORT"])
  delete process.env[k];
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-prompter-proj-"));
process.env.VIDI_PROJECTS_ROOT = PROJECTS;

const P = await import("../lib/prompter.ts");
type Tier = import("../lib/prompter.ts").Tier;
type PrompterAnswer = import("../lib/prompter.ts").PrompterAnswer;
type Brief = import("../lib/prompter.ts").Brief;

/** A TierRun that records which tier each call used and returns canned text. */
function mockRun(byTier: Partial<Record<Tier, string>>): {
  run: import("../lib/prompter.ts").TierRun;
  tiers: Tier[];
} {
  const tiers: Tier[] = [];
  const run: import("../lib/prompter.ts").TierRun = async ({ tier }) => {
    tiers.push(tier);
    return byTier[tier] ?? "";
  };
  return { run, tiers };
}

function fullAnswers(): PrompterAnswer[] {
  return P.PROMPTER_TOPICS.map((topic) => ({ topic, text: `answer for ${topic}` }));
}

function buildState(answers: PrompterAnswer[]) {
  let s = P.initialState();
  for (const a of answers) s = P.recordAnswer(s, a);
  return s;
}

// ── Question-flow state machine ─────────────────────────────────────────────

test("firstQuestion is the free-idea dump", () => {
  assert.equal(P.firstQuestion().topic, "idea");
  assert.equal(P.firstQuestion().allowFreeText, true);
  assert.ok(P.firstQuestion().chips.length >= 3);
});

test("nextQuestion walks the topics in ask order", () => {
  let s = P.initialState();
  assert.equal(P.nextQuestion(s)!.topic, "idea");
  s = P.recordAnswer(s, { topic: "idea", text: "a bakery site" });
  assert.equal(P.nextQuestion(s)!.topic, "audience");
});

test("nextQuestion returns null once every topic is asked", () => {
  const s = buildState(fullAnswers());
  assert.equal(P.nextQuestion(s), null);
});

test("a blank answer advances the flow but records no content", () => {
  let s = P.recordAnswer(P.initialState(), { topic: "idea" });
  assert.ok(s.askedTopics.includes("idea"));
  assert.equal(s.answers.length, 0);
});

test("isReady is false until every required topic is answered", () => {
  let s = P.initialState();
  for (const t of P.REQUIRED_TOPICS.slice(0, -1)) s = P.recordAnswer(s, { topic: t, text: "x" });
  assert.equal(P.isReady(s), false);
  s = P.recordAnswer(s, { topic: P.REQUIRED_TOPICS.at(-1)!, text: "x" });
  assert.equal(P.isReady(s), true);
});

test("status flips to ready only when all topics asked", () => {
  const partial = buildState(P.REQUIRED_TOPICS.map((topic) => ({ topic, text: "x" })));
  assert.equal(partial.status, "asking"); // optional topics not yet asked
  const full = buildState(fullAnswers());
  assert.equal(full.status, "ready");
});

test("re-answering a topic replaces, not duplicates", () => {
  let s = P.recordAnswer(P.initialState(), { topic: "idea", text: "first" });
  s = P.recordAnswer(s, { topic: "idea", text: "second" });
  const idea = s.answers.filter((a) => a.topic === "idea");
  assert.equal(idea.length, 1);
  assert.equal(idea[0].text, "second");
});

// ── Worker-tier question shaping ────────────────────────────────────────────

test("adaptQuestion returns the base question untouched on an empty state (no model call)", async () => {
  const { run, tiers } = mockRun({ worker: "reworded" });
  const base = P.firstQuestion();
  const out = await P.adaptQuestion(base, P.initialState(), run);
  assert.equal(out.question, base.question);
  assert.equal(tiers.length, 0);
});

test("adaptQuestion runs on the WORKER tier and applies the rewording", async () => {
  const { run, tiers } = mockRun({ worker: "What should the shop feel like?" });
  const s = P.recordAnswer(P.initialState(), { topic: "idea", text: "a shop" });
  const base = P.nextQuestion(s)!;
  const out = await P.adaptQuestion(base, s, run);
  assert.deepEqual(tiers, ["worker"]);
  assert.equal(out.question, "What should the shop feel like?");
  assert.deepEqual(out.chips, base.chips); // chips preserved
});

test("generateFollowUp runs on the WORKER tier; NONE → null", async () => {
  const s = P.recordAnswer(P.initialState(), { topic: "idea", text: "a shop" });
  const none = mockRun({ worker: "NONE" });
  assert.equal(await P.generateFollowUp(s, none.run), null);
  assert.deepEqual(none.tiers, ["worker"]);
  const some = mockRun({ worker: "Who will buy from you?" });
  assert.equal(await P.generateFollowUp(s, some.run), "Who will buy from you?");
});

// ── Model-policy seam ───────────────────────────────────────────────────────

test("resolveTierModel maps worker→sonnet/medium and deep→auto/high (default policy)", () => {
  assert.deepEqual(P.resolveTierModel("worker"), { model: "sonnet", effort: "medium" });
  assert.deepEqual(P.resolveTierModel("deep"), { model: "auto", effort: "high" });
});

// ── Brief synthesis (DEEP tier) ─────────────────────────────────────────────

const SYNTH_JSON = JSON.stringify({
  title: "Rosa's Bakery",
  oneSentence: "A little site so people can see and order our cakes.",
  who: "Local customers who want to order cakes",
  pages: ["Home", "Our cakes", "Order"],
  mustHave: ["Show the cakes", "Take an order"],
  later: ["Accounts"],
  lookAndFeel: "Warm and friendly",
  youWillProvide: ["Photos of the cakes"],
  notDoing: ["Delivery tracking"],
  doneMeans: "People can place an order",
});

test("synthesizeBrief runs on the DEEP tier and maps the JSON into a Brief", async () => {
  const { run, tiers } = mockRun({ deep: SYNTH_JSON });
  const brief = await P.synthesizeBrief(buildState(fullAnswers()), run);
  assert.deepEqual(tiers, ["deep"]);
  assert.equal(brief.title, "Rosa's Bakery");
  assert.deepEqual(brief.pages, ["Home", "Our cakes", "Order"]);
  assert.equal(brief.lookAndFeel, "Warm and friendly");
  assert.deepEqual(brief.notDoing, ["Delivery tracking"]);
});

test("synthesizeBrief tolerates prose-wrapped / fenced JSON", async () => {
  const wrapped = "Sure! Here is the plan:\n```json\n" + SYNTH_JSON + "\n```\nHope that helps.";
  const { run } = mockRun({ deep: wrapped });
  const brief = await P.synthesizeBrief(buildState(fullAnswers()), run);
  assert.equal(brief.title, "Rosa's Bakery");
});

test("synthesizeBrief falls back to an answers-derived brief on junk output", async () => {
  const { run } = mockRun({ deep: "sorry, I could not do that" });
  const answers: PrompterAnswer[] = [
    { topic: "idea", text: "a bakery site" },
    { topic: "audience", text: "locals" },
    { topic: "pages", chosenChips: ["Home", "Shop"] },
    { topic: "mustHave", chosenChips: ["Take payments"] },
    { topic: "lookAndFeel", text: "warm" },
    { topic: "done", text: "people can order" },
  ];
  const brief = await P.synthesizeBrief(buildState(answers), run);
  assert.equal(brief.oneSentence, "a bakery site"); // from the idea answer
  assert.deepEqual(brief.pages, ["Home", "Shop"]);
  assert.ok(brief.title.length > 0);
});

// ── Brief shape / rendering / section coercion ──────────────────────────────

test("renderBriefMarkdown emits every fixed section in order", () => {
  const brief = P.coerceBrief(JSON.parse(SYNTH_JSON));
  const md = P.renderBriefMarkdown(brief);
  const order = [
    "# Rosa's Bakery",
    "## In one sentence",
    "## Who it is for",
    "## Pages",
    "## Must have",
    "## Later",
    "## Look and feel",
    "## You will provide",
    "## Not doing",
    "## Done means",
  ];
  let cursor = -1;
  for (const heading of order) {
    const at = md.indexOf(heading);
    assert.ok(at > cursor, `section out of order or missing: ${heading}`);
    cursor = at;
  }
});

test("setSection coerces a newline string into a list section", () => {
  const brief = P.coerceBrief(JSON.parse(SYNTH_JSON));
  const edited = P.setSection(brief, "pages", "Home\n- About\n\nContact");
  assert.deepEqual(edited.pages, ["Home", "About", "Contact"]);
  assert.equal(P.renderSectionValue(edited, "pages"), "Home\nAbout\nContact");
});

// ── Persistence: save / version / history append ────────────────────────────

test("saveBrief writes BRIEF.md, brief.json and BRIEF-HISTORY.md at v1", () => {
  const brief = P.coerceBrief({ title: "Save Test One", oneSentence: "hi" });
  const saved = P.saveBrief(brief, { reason: "Created from your answers" });
  assert.equal(saved.version, 1);
  const dir = P.projectDir(saved.slug);
  assert.ok(fs.existsSync(path.join(dir, "BRIEF.md")));
  assert.ok(fs.existsSync(path.join(dir, "brief.json")));
  const history = fs.readFileSync(path.join(dir, "BRIEF-HISTORY.md"), "utf8");
  assert.match(history, /## v1 \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(history, /Created from your answers/);
});

test("re-saving the same slug bumps the version and appends history", () => {
  const brief = P.coerceBrief({ title: "Save Test Two", oneSentence: "one" });
  const v1 = P.saveBrief(brief, { reason: "first" });
  const v2 = P.saveBrief({ ...brief, oneSentence: "two" }, { reason: "second", slug: v1.slug });
  assert.equal(v2.version, 2);
  const history = fs.readFileSync(path.join(P.projectDir(v1.slug), "BRIEF-HISTORY.md"), "utf8");
  assert.equal((history.match(/## v\d+/g) || []).length, 2);
});

test("loadBrief round-trips a saved brief", () => {
  const brief = P.coerceBrief(JSON.parse(SYNTH_JSON));
  const saved = P.saveBrief(brief, { reason: "created", slug: "roundtrip" });
  const loaded = P.loadBrief("roundtrip");
  assert.ok(loaded);
  assert.deepEqual(loaded!.brief.pages, brief.pages);
  assert.equal(loaded!.version, saved.version);
});

test("editBriefSection changes one section, bumps version, appends history", () => {
  P.saveBrief(P.coerceBrief({ title: "Edit Me", lookAndFeel: "plain" }), {
    reason: "created",
    slug: "edit-me",
  });
  const edited = P.editBriefSection("edit-me", "lookAndFeel", "bold and colorful");
  assert.ok(edited);
  assert.equal(edited!.version, 2);
  assert.equal(edited!.brief.lookAndFeel, "bold and colorful");
  const history = fs.readFileSync(path.join(P.projectDir("edit-me"), "BRIEF-HISTORY.md"), "utf8");
  assert.match(history, /Edited Look and feel/);
});

test("editBriefSection on an unknown slug returns null", () => {
  assert.equal(P.editBriefSection("does-not-exist", "who", "x"), null);
});

test("listBriefs returns saved briefs newest first", () => {
  const before = P.listBriefs().length;
  P.saveBrief(P.coerceBrief({ title: "List Me AAA" }), { reason: "c", slug: "list-me-aaa" });
  const after = P.listBriefs();
  assert.equal(after.length, before + 1);
  assert.ok(after.some((b) => b.slug === "list-me-aaa"));
});

// ── Amendment before/after diffing (DEEP tier) ──────────────────────────────

test("diffBriefs returns only the changed sections with before/after", () => {
  const before = P.coerceBrief(JSON.parse(SYNTH_JSON));
  const after: Brief = { ...before, lookAndFeel: "Bold and colorful", pages: [...before.pages, "Reviews"] };
  const changes = P.diffBriefs(before, after);
  const keys = changes.map((c) => c.key).sort();
  assert.deepEqual(keys, ["lookAndFeel", "pages"]);
  const look = changes.find((c) => c.key === "lookAndFeel")!;
  assert.equal(look.before, "Warm and friendly");
  assert.equal(look.after, "Bold and colorful");
  assert.equal(look.label, "Look and feel");
});

test("diffBriefs on identical briefs returns no changes", () => {
  const brief = P.coerceBrief(JSON.parse(SYNTH_JSON));
  assert.deepEqual(P.diffBriefs(brief, { ...brief }), []);
});

test("proposeAmendment runs on the DEEP tier and reports the change set", async () => {
  const current = P.saveBrief(P.coerceBrief(JSON.parse(SYNTH_JSON)), {
    reason: "created",
    slug: "amend-me",
  });
  const nextBrief = { ...current.brief, lookAndFeel: "Playful and fun" };
  const { run, tiers } = mockRun({ deep: JSON.stringify(nextBrief) });
  const proposal = await P.proposeAmendment(current, "make it more playful", run);
  assert.deepEqual(tiers, ["deep"]);
  assert.equal(proposal.fromVersion, current.version);
  assert.equal(proposal.toVersion, current.version + 1);
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].key, "lookAndFeel");
});

test("proposeAmendment on junk output proposes no change", async () => {
  const current = P.loadBrief("amend-me")!;
  const { run } = mockRun({ deep: "hmm" });
  const proposal = await P.proposeAmendment(current, "something", run);
  assert.deepEqual(proposal.changes, []);
});

test("applyAmendment saves the approved brief as the next version", () => {
  const current = P.loadBrief("amend-me")!;
  const applied = P.applyAmendment("amend-me", { ...current.brief, lookAndFeel: "Playful and fun" });
  assert.equal(applied.version, current.version + 1);
  assert.equal(P.loadBrief("amend-me")!.brief.lookAndFeel, "Playful and fun");
});

// ── Build handoff ───────────────────────────────────────────────────────────

test("briefBuildSeed carries the plan as the task", () => {
  const brief = P.coerceBrief(JSON.parse(SYNTH_JSON));
  const seed = P.briefBuildSeed(brief);
  assert.match(seed, /build this/i);
  assert.ok(seed.includes("Rosa's Bakery"));
  assert.ok(seed.includes("## Done means"));
});

// ── Route auth wiring (static — @/ alias imports can't load under node --test) ─

const API_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "app",
  "api",
  "prompter"
);

function routeSrc(...seg: string[]): string {
  return fs.readFileSync(path.join(API_DIR, ...seg, "route.ts"), "utf8");
}

test("every Prompter write handler gates on requireWriteAuth + JSON content-type", () => {
  const writeRoutes = [["next"], ["synthesize"], ["brief"], ["amend"], ["build"]];
  for (const seg of writeRoutes) {
    const src = routeSrc(...seg);
    const post = src.slice(src.indexOf("export async function POST"));
    assert.match(post, /requireWriteAuth\(/, `${seg.join("/")} POST missing requireWriteAuth`);
    assert.match(post, /requireJsonContentType\(/, `${seg.join("/")} POST missing JSON gate`);
  }
});

test("every Prompter read handler gates on requireReadAuth", () => {
  for (const seg of [[], ["brief"]]) {
    const src = routeSrc(...(seg as string[]));
    const get = src.slice(src.indexOf("export async function GET"));
    assert.match(get, /requireReadAuth\(/, `${seg.join("/") || "root"} GET missing requireReadAuth`);
  }
});

test("requireWriteAuth rejects a tokenless request (gate sanity)", async () => {
  const { requireWriteAuth } = await import("../lib/origin.ts");
  const r = requireWriteAuth(new Request("http://127.0.0.1:4183/api/prompter/build", { method: "POST" }));
  assert.ok(r && r.status === 401);
});
