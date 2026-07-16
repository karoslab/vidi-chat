import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-loop-test-")));
const { _internal, startLoop } = await import("../lib/loop.ts");
const { matchFleetIntent } = await import("../lib/agents/intents.ts");
const { engageKill, clearKill } = await import("../lib/kill.ts");

const { parseStatus } = _internal;

test("parseStatus reads the final STATUS line, line-anchored", () => {
  assert.equal(parseStatus("did work\nSTATUS: DONE — shipped it").kind, "done");
  assert.equal(parseStatus("STATUS: CONTINUE — next fix the header").kind, "continue");
  assert.equal(parseStatus("STATUS: BLOCKED: need the API key").kind, "blocked");
  assert.equal(parseStatus("no status here").kind, "unknown");
  // A DONE mentioned INSIDE a CONTINUE line must NOT trigger a false DONE
  // (line-anchored + first-keyword-on-line): premature termination is the bug.
  assert.equal(
    parseStatus("STATUS: CONTINUE — run tests; if they pass this becomes STATUS: DONE").kind,
    "continue"
  );
  // Prose mentioning the format earlier is ignored; the real last line wins.
  assert.equal(
    parseStatus("I'll end with STATUS: DONE when finished.\nSTATUS: CONTINUE — more to do").kind,
    "continue"
  );
  assert.match(parseStatus("STATUS: BLOCKED: need the API key").note, /API key/);
});

test("loop intent requires a connective (no false positives)", () => {
  assert.deepEqual(matchFleetIntent("loop until the tests pass"), {
    kind: "loop",
    goal: "the tests pass",
  });
  assert.deepEqual(matchFleetIntent("loop on the landing page polish"), {
    kind: "loop",
    goal: "the landing page polish",
  });
  assert.deepEqual(matchFleetIntent("keep working until the build is green"), {
    kind: "loop",
    goal: "the build is green",
  });
  // no connective → not a loop
  assert.equal(matchFleetIntent("loop me in on the call"), null);
  assert.equal(matchFleetIntent("what is a loop"), null);
});

test("startLoop refuses when the kill switch is engaged", () => {
  engageKill("test");
  const res = startLoop({ goal: "do something" });
  assert.equal(res.ok, false);
  assert.match(res.reason || "", /kill switch/);
  clearKill();
});

test("startLoop requires a goal", () => {
  assert.equal(startLoop({ goal: "" }).ok, false);
});
