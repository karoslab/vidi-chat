import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// chdir keeps any incidental cwd-based writes off the real tree, but the spool
// itself lives at an ABSOLUTE path (EVENTS_SPOOL_PENDING), so we pass an
// explicit override dir — the one job of spoolEvent's optional 2nd arg.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-event-spool-test-"));
process.chdir(tmpDir);
const spoolDir = path.join(tmpDir, "pending");

const { spoolEvent } = await import("../lib/event-spool.ts");

const baseEvent = {
  source: "app",
  kind: "presence.wake",
  priority: "normal" as const,
  title: "the owner woke the Mac",
  spoken: "Morning — you're back at the desk.",
  ttlMinutes: 240,
};

test("spoolEvent fills id and ts when absent", () => {
  const before = Date.now();
  const event = spoolEvent({ ...baseEvent }, spoolDir);
  const after = Date.now();

  assert.match(event.id, /^evt-\d+-[0-9a-f]+$/);
  assert.equal(typeof event.ts, "number");
  assert.ok(event.ts >= before && event.ts <= after);
});

test("spoolEvent writes a parseable JSON file with every required key", () => {
  const event = spoolEvent({ ...baseEvent, kind: "dg.verdict.flip" }, spoolDir);
  const file = path.join(spoolDir, `${event.id}.json`);

  assert.ok(fs.existsSync(file), "spool file should exist");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const key of ["id", "ts", "source", "kind", "priority", "title", "spoken", "ttlMinutes"]) {
    assert.ok(key in parsed, `written event missing required key: ${key}`);
  }
  // Round-trips to exactly what spoolEvent returned.
  assert.deepEqual(parsed, event);
});

test("spoolEvent is atomic — no .tmp file left behind", () => {
  spoolEvent({ ...baseEvent }, spoolDir);
  const leftovers = fs.readdirSync(spoolDir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no torn .tmp files may remain after a write");
});

test("spoolEvent honours a caller-supplied id and ts", () => {
  const event = spoolEvent({ ...baseEvent, id: "evt-fixed-1", ts: 123 }, spoolDir);
  assert.equal(event.id, "evt-fixed-1");
  assert.equal(event.ts, 123);
  assert.ok(fs.existsSync(path.join(spoolDir, "evt-fixed-1.json")));
});
