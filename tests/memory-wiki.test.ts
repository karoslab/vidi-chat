import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The wiki lives under WORKSPACE_ROOT/<brainDirName>; state + journal under the
// data dir; "bring your stuff" is jailed to HOME. Point all three at fresh temp
// dirs BEFORE importing the module (workspace.ts reads the env at load), same
// pattern as model-policy.test.ts.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-mem-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-mem-ws-"));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-mem-data-"));
process.env.HOME = HOME;
process.env.VIDI_WORKSPACE_ROOT = WS;
process.env.VIDI_DATA_DIR = DATA;

const M = await import("../lib/memory-wiki.ts");

/** Remove the wiki and reset per-install state so a test starts clean. */
function cleanAll() {
  fs.rmSync(M.wikiRoot(), { recursive: true, force: true });
  for (const f of ["journey-memory.json", "journal.jsonl"]) {
    fs.rmSync(path.join(DATA, f), { force: true });
  }
}

/** A fake worker distiller that returns a JSON array of `n` linked notes,
 *  wrapped in prose + a code fence to exercise the tolerant parser. */
function fakeDistiller(n: number): (prompt: string) => Promise<string> {
  return async () => {
    const notes = Array.from({ length: n }, (_, i) => ({
      slug: `note-${i + 1}`,
      title: `Note ${i + 1}`,
      body: `This is note ${i + 1}. It links to [[note-${((i + 1) % n) + 1}]].`,
    }));
    return "Here are your notes:\n```json\n" + JSON.stringify(notes) + "\n```\n";
  };
}

test("scaffoldWiki is idempotent: creates once, then verifies", () => {
  cleanAll();
  const first = M.scaffoldWiki();
  assert.equal(first.created, true);
  assert.equal(first.root, M.wikiRoot());
  // Real folder, is a git repo, has at least one seeded note.
  assert.ok(fs.existsSync(M.wikiRoot()));
  assert.ok(fs.existsSync(path.join(M.wikiRoot(), ".git")));
  assert.ok(fs.existsSync(path.join(M.wikiRoot(), "README.md")));
  assert.ok(M.countNotes() >= 1);
  for (const folder of ["inbox", "journal", "notes"]) {
    assert.ok(fs.existsSync(path.join(M.wikiRoot(), folder)), `${folder} exists`);
  }

  // Re-running does not re-create and does not wipe anything.
  const second = M.scaffoldWiki();
  assert.equal(second.created, false);
  assert.equal(M.verifyWiki().ok, true);
});

test("verifyWiki truth table", () => {
  cleanAll();
  // No folder yet.
  assert.equal(M.verifyWiki().ok, false);
  M.scaffoldWiki();
  assert.equal(M.verifyWiki().ok, true);
  // A wiki with a folder + git but zero notes fails on the note count.
  fs.rmSync(path.join(M.wikiRoot(), "notes"), { recursive: true, force: true });
  fs.mkdirSync(path.join(M.wikiRoot(), "notes"), { recursive: true });
  const r = M.verifyWiki();
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no notes/i);
});

test("runInterview writes the distilled notes and records state", async () => {
  cleanAll();
  M.scaffoldWiki();
  const before = M.countNotes();
  const result = await M.runInterview(
    {
      who_you_are: "I am a baker.",
      what_you_do: "I run a small bakery.",
      what_building: "A new sourdough line.",
      who_matters: "My partner and my two regulars.",
      how_you_work: "Early mornings, quiet focus.",
    },
    fakeDistiller(16)
  );
  assert.equal(result.written, 16);
  assert.equal(M.countNotes(), before + 16);
  // The notes are real files with wiki links in them.
  const sample = fs.readFileSync(path.join(M.notesDir(), "note-1.md"), "utf8");
  assert.match(sample, /\[\[note-2\]\]/);
  // State marks the interview done.
  const state = M.readMemoryState();
  assert.ok(state.interviewDoneAt);
  assert.equal(state.interviewNotes, 16);
});

test("parseDistilledNotes tolerates junk and drops malformed notes", () => {
  assert.deepEqual(M.parseDistilledNotes("no json here"), []);
  assert.deepEqual(M.parseDistilledNotes(""), []);
  const mixed = M.parseDistilledNotes(
    'prose [{"slug":"a","title":"A","body":"x"},{"title":"","body":"y"},{"slug":"a","title":"Dup","body":"z"}] tail'
  );
  // The empty-title note is dropped; the duplicate slug is de-duped.
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].slug, "a");
  assert.notEqual(mixed[1].slug, "a");
});

test("bring your stuff: refuses a folder outside home", async () => {
  cleanAll();
  M.scaffoldWiki();
  // WS (the workspace temp dir) is not under HOME.
  const outside = path.join(WS, "not-home");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "note.md"), "hello");
  const v = M.validateSourceFolder(outside);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /home folder/i);
  const r = await M.ingestFolder(outside, fakeDistiller(3));
  assert.equal(r.ok, false);
});

test("bring your stuff: refuses a secret folder", async () => {
  cleanAll();
  M.scaffoldWiki();
  const ssh = path.join(HOME, ".ssh");
  fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(ssh, "id_rsa.txt"), "PRIVATE KEY");
  const v = M.validateSourceFolder(ssh);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /private or system/i);
});

test("bring your stuff: reads text, skips secrets, binaries, and oversize files", async () => {
  cleanAll();
  M.scaffoldWiki();
  const src = path.join(HOME, "mystuff");
  fs.mkdirSync(path.join(src, "data"), { recursive: true });
  fs.writeFileSync(path.join(src, "good1.md"), "a real note about bread");
  fs.writeFileSync(path.join(src, "good2.txt"), "another real note");
  fs.writeFileSync(path.join(src, "pic.png"), Buffer.from([0, 1, 2, 0, 3])); // binary
  fs.writeFileSync(path.join(src, "big.md"), "x".repeat(M.INGEST_LIMITS.maxFileBytes + 10));
  // A secret-matching file that is otherwise text-like (**/data/accounts.json).
  fs.writeFileSync(path.join(src, "data", "accounts.json"), '{"secret":true}');

  const collected = M.collectTextFiles(src);
  const names = collected.files.map((f) => f.relPath).sort();
  assert.deepEqual(names, ["good1.md", "good2.txt"]);
  assert.ok(collected.skipped >= 3); // png + big + accounts.json

  const r = await M.ingestFolder(src, fakeDistiller(4));
  assert.equal(r.ok, true);
  assert.equal(r.filesRead, 2);
  assert.equal(r.written, 4);
  // The source folder is recorded.
  const sources = fs.readFileSync(M.sourcesFile(), "utf8");
  assert.ok(sources.includes(src));
});

test("bring your stuff: honors the maxFiles cap", () => {
  cleanAll();
  const src = path.join(HOME, "manyfiles");
  fs.mkdirSync(src, { recursive: true });
  const count = M.INGEST_LIMITS.maxFiles + 5;
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(src, `n${i}.txt`), `note ${i}`);
  }
  const collected = M.collectTextFiles(src);
  assert.equal(collected.files.length, M.INGEST_LIMITS.maxFiles);
});
