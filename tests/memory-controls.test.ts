import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// These suites model the OWNER install (owner-default identity in prompts
// and brain paths). The customer identity contract is pinned in user-config.test.ts.
process.env.VIDI_OWNER = "1";


/**
 * Unit tests for lib/memory-controls — the memory OWNERSHIP surface (list /
 * forget / correct / export / reset). Isolation: the notes live under the
 * brain root (WORKSPACE_ROOT/<brainDirName>/vidi/notes) and the fleet memory
 * under data/, so we point BOTH at a throwaway temp dir BEFORE importing the
 * module (WORKSPACE_ROOT is computed once at import, data-dir reads cwd at call
 * time). VIDI_TEST=1 also short-circuits the gbrain sync so no test shells out.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-mem-ctl-"));
process.env.VIDI_TEST = "1";
process.env.VIDI_WORKSPACE_ROOT = ROOT;
process.chdir(ROOT);

const {
  listNotes,
  listFleetMemory,
  forgetNote,
  correctNote,
  exportMemory,
  resetMemory,
  MemoryControlError,
  RESET_CONFIRM_PHRASE,
  NOTE_SOURCE,
} = await import("../lib/memory-controls.ts");

// The brain dir name is the module's default (neutral now); sourced here
// (AFTER the workspace-root env is set, so WORKSPACE_ROOT resolves correctly)
// so fixtures land where the source resolves the brain root, without a literal.
const { DEFAULT_USER_CONFIG } = await import("../lib/user-config.ts");

const NOTES_DIR = path.join(ROOT, DEFAULT_USER_CONFIG.brainDirName, "vidi", "notes");
const FLEET_FILE = path.join(ROOT, "data", "memory.jsonl");

function reset() {
  fs.rmSync(path.join(ROOT, DEFAULT_USER_CONFIG.brainDirName), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, "data"), { recursive: true, force: true });
}

function writeNote(id: string, content: string) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(path.join(NOTES_DIR, id), content);
}

function writeFleet(lines: string[]) {
  fs.mkdirSync(path.dirname(FLEET_FILE), { recursive: true });
  fs.writeFileSync(FLEET_FILE, lines.join("\n") + "\n");
}

test("listNotes: empty stores → empty lists, never a throw", () => {
  reset();
  const out = listNotes();
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.fleetMemory, []);
});

test("listNotes: parses id, createdAt (from stamp), title, body, source; newest first", () => {
  reset();
  writeNote(
    "2026-07-01-09-00-00.md",
    "# Old note\n\nremember the old thing\n\n*the owner told Vidi to remember this on 2026-07-01.*\n"
  );
  writeNote(
    "2026-07-09-18-30-45.md",
    "# New note\n\nremember the new thing\n\n*the owner told Vidi to remember this on 2026-07-09.*\n"
  );
  const { notes } = listNotes();
  assert.equal(notes.length, 2);
  // Newest first.
  assert.equal(notes[0].id, "2026-07-09-18-30-45.md");
  assert.equal(notes[0].title, "New note");
  assert.equal(notes[0].source, NOTE_SOURCE);
  assert.equal(notes[0].createdAt, "2026-07-09T18:30:45.000Z");
  assert.match(notes[0].body, /remember the new thing/);
  assert.equal(notes[1].id, "2026-07-01-09-00-00.md");
});

test("listFleetMemory: parses valid lines, skips corrupt/blank", () => {
  reset();
  writeFleet([
    JSON.stringify({ ts: 1000, agent: "vidi", text: "a fact", tags: ["x"] }),
    "{ not json",
    "",
    JSON.stringify({ ts: 2000, agent: "scout", text: "another" }),
    JSON.stringify({ nope: true }), // missing ts/text → skipped
  ]);
  const items = listFleetMemory();
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "a fact");
  assert.deepEqual(items[0].tags, ["x"]);
  assert.equal(items[1].agent, "scout");
});

test("forgetNote: deletes the note file", () => {
  reset();
  writeNote("2026-07-09-18-30-45.md", "# keep me\n\nbody\n");
  forgetNote("2026-07-09-18-30-45.md");
  assert.equal(fs.existsSync(path.join(NOTES_DIR, "2026-07-09-18-30-45.md")), false);
  assert.equal(listNotes().notes.length, 0);
});

test("forgetNote: a nonexistent note → 404 MemoryControlError", () => {
  reset();
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const err = (() => {
    try {
      forgetNote("2026-01-01-00-00-00.md");
      return null;
    } catch (e) {
      return e as InstanceType<typeof MemoryControlError>;
    }
  })();
  assert.ok(err instanceof MemoryControlError);
  assert.equal(err!.status, 404);
});

for (const bad of ["../../etc/passwd", "../secret.md", "a/b.md", "sub\\note.md", ".", "..", ""]) {
  test(`forgetNote: rejects traversal / non-segment id ${JSON.stringify(bad)}`, () => {
    reset();
    // A file that a traversal id would target, placed OUTSIDE the notes dir.
    const outside = path.join(ROOT, DEFAULT_USER_CONFIG.brainDirName, "vidi", "secret.md");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "secret");
    assert.throws(() => forgetNote(bad), MemoryControlError);
    // The out-of-jail file is never touched.
    assert.equal(fs.existsSync(outside), true);
  });
}

test("symlink note: a note that is a symlink is refused (no read-through, no write-through, not listed)", () => {
  reset();
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  // A secret OUTSIDE the notes jail, and a symlink note pointing at it.
  const secret = path.join(ROOT, "outside-secret.md");
  fs.writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n");
  const link = path.join(NOTES_DIR, "evil.md");
  fs.symlinkSync(secret, link);
  // Also a real note so the listing is not simply empty.
  writeNote("2026-07-09-18-30-45.md", "# real\n\nreal note\n");

  // Listing / export must NOT surface the symlinked target's content.
  const listed = listNotes().notes.map((n) => n.id);
  assert.ok(!listed.includes("evil.md"), "symlink note must not be listed");
  assert.ok(listed.includes("2026-07-09-18-30-45.md"), "real note still listed");
  const exported = JSON.stringify(exportMemory());
  assert.doesNotMatch(exported, /BEGIN OPENSSH PRIVATE KEY/, "secret must not leak into export");

  // forget/correct on the symlink id are refused, and the target is untouched.
  assert.throws(() => forgetNote("evil.md"), MemoryControlError);
  assert.throws(() => correctNote("evil.md", "PWNED"), MemoryControlError);
  assert.equal(fs.readFileSync(secret, "utf8"), "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n");
  assert.equal(fs.existsSync(link), true, "the symlink itself is left in place, not deleted");
});

test("correctNote: rewrites body, preserves attribution footer, appends corrected line", () => {
  reset();
  writeNote(
    "2026-07-09-18-30-45.md",
    "# original\n\nthe old body\n\n*the owner told Vidi to remember this on 2026-07-09.*\n"
  );
  correctNote("2026-07-09-18-30-45.md", "the corrected body");
  const after = fs.readFileSync(path.join(NOTES_DIR, "2026-07-09-18-30-45.md"), "utf8");
  assert.match(after, /the corrected body/);
  assert.doesNotMatch(after, /the old body/);
  // Attribution footer preserved verbatim.
  assert.match(after, /\*the owner told Vidi to remember this on 2026-07-09\.\*/);
  // Corrected line appended with today's date.
  const today = new Date().toISOString().slice(0, 10);
  assert.match(after, new RegExp(`\\*Corrected on ${today}\\.\\*`));
});

test("correctNote: an empty body is refused", () => {
  reset();
  writeNote("2026-07-09-18-30-45.md", "# x\n\nbody\n");
  assert.throws(() => correctNote("2026-07-09-18-30-45.md", "   "), MemoryControlError);
});

test("correctNote: rejects a traversal id", () => {
  reset();
  assert.throws(() => correctNote("../../etc/passwd", "hi"), MemoryControlError);
});

test("exportMemory: manifest shape (schemaVersion, notes+markdown, fleet, explanation)", () => {
  reset();
  writeNote("2026-07-09-18-30-45.md", "# note one\n\nbody one\n");
  writeFleet([JSON.stringify({ ts: 5, agent: "vidi", text: "fleet fact" })]);
  const dump = exportMemory();
  assert.equal(dump.schemaVersion, 1);
  assert.ok(typeof dump.exportedAt === "string");
  assert.equal(dump.notes.length, 1);
  assert.equal(dump.notes[0].markdown, dump.notes[0].body);
  assert.match(dump.notes[0].markdown, /body one/);
  assert.equal(dump.fleetMemory.length, 1);
  assert.equal(dump.explanation.primary, "notes are the primary data");
  assert.equal(dump.explanation.rebuildable, "the search index is rebuilt from these files");
});

test("resetMemory: wrong phrase throws and moves nothing", () => {
  reset();
  writeNote("2026-07-09-18-30-45.md", "# n\n\nb\n");
  writeFleet([JSON.stringify({ ts: 1, agent: "vidi", text: "f" })]);
  assert.throws(() => resetMemory({ confirmPhrase: "nope" }), MemoryControlError);
  // Untouched.
  assert.equal(fs.existsSync(NOTES_DIR), true);
  assert.equal(fs.existsSync(FLEET_FILE), true);
});

test("resetMemory: requires the EXACT confirm phrase", () => {
  reset();
  // Near-misses all rejected.
  for (const near of ["Delete my memory", "delete my memory ", "delete memory", ""]) {
    assert.throws(() => resetMemory({ confirmPhrase: near }), MemoryControlError);
  }
  assert.equal(RESET_CONFIRM_PHRASE, "delete my memory");
});

test("resetMemory: right phrase MOVES notes + fleet to a trash dir, leaves the wider brain untouched", () => {
  reset();
  writeNote("2026-07-09-18-30-45.md", "# n\n\nb\n");
  writeFleet([JSON.stringify({ ts: 1, agent: "vidi", text: "f" })]);
  // A sibling brain file and thread history that reset must NEVER touch.
  const wikiFile = path.join(ROOT, DEFAULT_USER_CONFIG.brainDirName, "wiki", "keep.md");
  fs.mkdirSync(path.dirname(wikiFile), { recursive: true });
  fs.writeFileSync(wikiFile, "important");
  const threadFile = path.join(ROOT, "data", "threads", "t1.json");
  fs.mkdirSync(path.dirname(threadFile), { recursive: true });
  fs.writeFileSync(threadFile, "{}");

  const result = resetMemory({ confirmPhrase: RESET_CONFIRM_PHRASE });
  assert.equal(result.movedNotes, true);
  assert.equal(result.movedFleetMemory, true);
  // Originals gone (moved, not deleted).
  assert.equal(fs.existsSync(NOTES_DIR), false);
  assert.equal(fs.existsSync(FLEET_FILE), false);
  // Recoverable copy on disk.
  assert.equal(fs.existsSync(path.join(result.trashDir, "notes", "2026-07-09-18-30-45.md")), true);
  assert.equal(fs.existsSync(path.join(result.trashDir, "memory.jsonl")), true);
  // The wider brain and thread history are untouched.
  assert.equal(fs.readFileSync(wikiFile, "utf8"), "important");
  assert.equal(fs.existsSync(threadFile), true);
});

test("resetMemory: tolerates empty stores (nothing to move)", () => {
  reset();
  const result = resetMemory({ confirmPhrase: RESET_CONFIRM_PHRASE });
  assert.equal(result.movedNotes, false);
  assert.equal(result.movedFleetMemory, false);
  assert.ok(fs.existsSync(result.trashDir));
});
