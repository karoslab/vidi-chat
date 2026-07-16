import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate on-disk state exactly like journal.test.ts: chdir into a temp cwd
// BEFORE importing, so data-dir.ts resolves data/ under the temp dir. The
// window store and journal are module-global paths captured from process.cwd().
const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-hunk-attr-"));
process.chdir(testCwd);

const {
  computeHunks,
  actorAt,
  attributeChange,
  summarizeActors,
  openSession,
  closeSession,
  readWindows,
  journalFileChange,
  EXTERNAL_ACTOR,
} = await import("../lib/hunk-attribution.ts");
const { readJournal } = await import("../lib/journal.ts");

function resetState() {
  try {
    fs.rmSync(path.join(testCwd, "data"), { recursive: true, force: true });
  } catch {
    /* fresh */
  }
}

// Serialize: every test shares the same cwd-relative data/ dir.
let tail: Promise<void> = Promise.resolve();
function serial(name: string, fn: () => void | Promise<void>) {
  test(name, () => {
    const run = tail.then(() => {
      resetState();
      return fn();
    });
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  });
}

// ---- computeHunks: pure line diff → contiguous changed regions ----

serial("computeHunks tags a single modified line as one hunk", () => {
  const hunks = computeHunks("a\nb\nc", "a\nB\nc");
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].removed, ["b"]);
  assert.deepEqual(hunks[0].added, ["B"]);
  assert.equal(hunks[0].beforeStart, 2);
  assert.equal(hunks[0].afterStart, 2);
});

serial("computeHunks reports a pure insertion (nothing removed)", () => {
  const hunks = computeHunks("a\nc", "a\nb\nc");
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].removed, []);
  assert.deepEqual(hunks[0].added, ["b"]);
});

serial("computeHunks reports a pure deletion (nothing added)", () => {
  const hunks = computeHunks("a\nb\nc", "a\nc");
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].removed, ["b"]);
  assert.deepEqual(hunks[0].added, []);
});

serial("computeHunks separates two non-adjacent changes into two hunks", () => {
  const hunks = computeHunks("a\nb\nc\nd\ne", "a\nX\nc\nd\nY");
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].removed, ["b"]);
  assert.deepEqual(hunks[0].added, ["X"]);
  assert.deepEqual(hunks[1].removed, ["e"]);
  assert.deepEqual(hunks[1].added, ["Y"]);
});

serial("computeHunks returns no hunks when content is unchanged", () => {
  assert.deepEqual(computeHunks("a\nb\nc", "a\nb\nc"), []);
});

// ---- actorAt: session window → session id, else external ----

serial("actorAt returns the session id for a ts inside a closed window", () => {
  const windows = [{ sessionId: "sess-1", start: 100, end: 200 }];
  assert.equal(actorAt(150, windows), "sess-1");
  assert.equal(actorAt(100, windows), "sess-1"); // inclusive start
  assert.equal(actorAt(200, windows), "sess-1"); // inclusive end
});

serial("actorAt returns external for a ts outside every window", () => {
  const windows = [{ sessionId: "sess-1", start: 100, end: 200 }];
  assert.equal(actorAt(50, windows), EXTERNAL_ACTOR);
  assert.equal(actorAt(300, windows), EXTERNAL_ACTOR);
  assert.equal(actorAt(150, []), EXTERNAL_ACTOR);
});

serial("actorAt treats a null end as a still-open window", () => {
  const windows = [{ sessionId: "sess-open", start: 100, end: null }];
  assert.equal(actorAt(10_000, windows), "sess-open");
  assert.equal(actorAt(99, windows), EXTERNAL_ACTOR);
});

serial("actorAt picks the innermost (latest-started) overlapping window", () => {
  const windows = [
    { sessionId: "outer", start: 100, end: 400 },
    { sessionId: "inner", start: 200, end: 300 },
  ];
  assert.equal(actorAt(250, windows), "inner");
  assert.equal(actorAt(150, windows), "outer");
});

// ---- attributeChange: hunks + actor ----

serial("attributeChange tags hunks with the session active at change time", () => {
  const windows = [{ sessionId: "sess-1", start: 100, end: 200 }];
  const attr = attributeChange(
    { path: "foo.ts", before: "a\nb", after: "a\nB", ts: 150 },
    windows
  );
  assert.equal(attr.path, "foo.ts");
  assert.equal(attr.hunks.length, 1);
  assert.equal(attr.hunks[0].actor, "sess-1");
});

serial("attributeChange tags an out-of-window change as external", () => {
  const windows = [{ sessionId: "sess-1", start: 100, end: 200 }];
  const attr = attributeChange(
    { path: "foo.ts", before: "a\nb", after: "a\nB", ts: 999 },
    windows
  );
  assert.equal(attr.hunks[0].actor, EXTERNAL_ACTOR);
});

serial("summarizeActors tallies hunks per actor", () => {
  const windows = [{ sessionId: "sess-1", start: 0, end: 1000 }];
  const attr = attributeChange(
    { path: "foo.ts", before: "a\nb\nc\nd\ne", after: "a\nX\nc\nd\nY", ts: 500 },
    windows
  );
  const tally = summarizeActors(attr);
  assert.deepEqual(tally, [{ actor: "sess-1", hunks: 2 }]);
});

// ---- session window persistence (boundary tracking) ----

serial("openSession then closeSession round-trips through the window store", () => {
  openSession("sess-A", 1000);
  let windows = readWindows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].sessionId, "sess-A");
  assert.equal(windows[0].start, 1000);
  assert.equal(windows[0].end, null);

  closeSession("sess-A", 2000);
  windows = readWindows();
  assert.equal(windows[0].end, 2000);
});

serial("openSession is idempotent for an already-open session", () => {
  openSession("sess-A", 1000);
  openSession("sess-A", 1500);
  assert.equal(readWindows().length, 1);
});

serial("readWindows fails open to an empty array when the store is absent", () => {
  assert.deepEqual(readWindows(), []);
});

// ---- journal surfacing ----

serial("journalFileChange writes a journal entry carrying the attribution", () => {
  openSession("sess-J", 1000);
  const attr = journalFileChange({
    threadId: "thread-1",
    path: "src/app.ts",
    before: "x\ny",
    after: "x\nZ",
    ts: 1200,
  });
  assert.ok(attr);
  assert.equal(attr!.hunks[0].actor, "sess-J");

  const entries = readJournal(1);
  assert.equal(entries[0].tool, "FileChange");
  assert.match(entries[0].summary, /src\/app\.ts/);
  assert.deepEqual(entries[0].attribution, [{ actor: "sess-J", hunks: 1 }]);
});

serial("journalFileChange attributes to external when no session is open", () => {
  const attr = journalFileChange({
    threadId: "thread-1",
    path: "src/app.ts",
    before: "x\ny",
    after: "x\nZ",
    ts: 1200,
  });
  assert.ok(attr);
  assert.equal(attr!.hunks[0].actor, EXTERNAL_ACTOR);
  assert.deepEqual(readJournal(1)[0].attribution, [{ actor: EXTERNAL_ACTOR, hunks: 1 }]);
});

serial("journalFileChange writes nothing for an unchanged file", () => {
  const attr = journalFileChange({
    threadId: "thread-1",
    path: "src/app.ts",
    before: "x\ny",
    after: "x\ny",
    ts: 1200,
  });
  assert.equal(attr, null);
  assert.deepEqual(readJournal(1), []);
});
