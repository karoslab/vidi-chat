import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ledger resolves its path off process.cwd()+"/data", so isolate cwd into
// a fresh temp dir BEFORE importing (same pattern as policy.test.ts). Each
// test that needs a clean slate re-chdirs into its own temp dir.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-commitments-test-")));
const {
  addCommitment,
  resolveCommitment,
  openCommitments,
  dueCommitments,
  somedayCommitments,
  dropCommitment,
} = await import("../lib/commitments.ts");

import type { Commitment } from "../lib/commitments.ts";

function freshCwd(tag: string): void {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), `vidi-commitments-${tag}-`)));
}

test("add + openCommitments: a new promise is open and readable back", () => {
  freshCwd("add");
  const c = addCommitment({ text: "check the logs tonight", source: "voice" });
  assert.equal(c.status, "open");
  assert.equal(c.text, "check the logs tonight");
  assert.equal(c.source, "voice");
  assert.ok(c.id && typeof c.ts === "number");

  const open = openCommitments();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, c.id);
});

test("resolveCommitment: fuzzy-matches the closest open item and marks it done", () => {
  freshCwd("resolve");
  addCommitment({ text: "email the plumber about the leak" });
  const target = addCommitment({ text: "check the server logs tonight" });
  addCommitment({ text: "book flights to Bengaluru" });

  // Words overlap "check", "the", "logs" — should pick the server-logs promise.
  const resolved = resolveCommitment("did you check the logs?");
  assert.ok(resolved, "should resolve to a commitment");
  assert.equal(resolved!.id, target.id);
  assert.equal(resolved!.status, "done");

  // It should no longer be open; the other two remain.
  const open = openCommitments();
  assert.equal(open.length, 2);
  assert.ok(!open.some((c: Commitment) => c.id === target.id));
});

test("resolveCommitment: zero word-overlap returns null and closes nothing", () => {
  freshCwd("resolve-none");
  addCommitment({ text: "water the plants" });
  const resolved = resolveCommitment("quarterly revenue projections");
  assert.equal(resolved, null);
  assert.equal(openCommitments().length, 1);
});

test("dueCommitments: 'tonight' is due after 21:00, not before; ISO respected", () => {
  freshCwd("due");
  addCommitment({ text: "call mom tonight", due: "tonight" });
  addCommitment({ text: "deploy on friday", due: "2026-07-10T09:00:00Z" });
  addCommitment({ text: "vague someday thing", due: "whenever" }); // unparseable

  const beforeNine = new Date(2026, 6, 3, 18, 0, 0); // 18:00 local, same day
  const afterNine = new Date(2026, 6, 3, 22, 0, 0); // 22:00 local, same day

  // At 18:00 the "tonight" (21:00) promise is not yet due; the far ISO isn't either.
  assert.equal(dueCommitments(beforeNine).length, 0);

  // At 22:00 the "tonight" promise is due; the ISO friday one and the
  // unparseable "whenever" one are still not.
  const due = dueCommitments(afterNine);
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "call mom tonight");
});

test("dueCommitments: unknown/unparseable due is never auto-due", () => {
  freshCwd("due-unknown");
  addCommitment({ text: "figure out taxes", due: "eventually" });
  addCommitment({ text: "no due date at all" }); // no due field
  const farFuture = new Date(2099, 0, 1, 12, 0, 0);
  assert.equal(dueCommitments(farFuture).length, 0);
});

test("somedayCommitments: only open, undated promises; datable and resolved excluded", () => {
  freshCwd("someday");
  addCommitment({ text: "figure out taxes", due: "eventually" }); // undated → someday
  addCommitment({ text: "no due date at all" }); // no due → someday
  addCommitment({ text: "call mom tonight", due: "tonight" }); // datable → excluded
  addCommitment({ text: "deploy friday", due: "2026-07-10T09:00:00Z" }); // datable → excluded
  const resolvable = addCommitment({ text: "someday sort the garage" }); // undated
  resolveCommitment("sort the garage"); // now done → excluded

  const someday = somedayCommitments(new Date(2026, 6, 3, 12));
  const texts = someday.map((c: Commitment) => c.text).sort();
  assert.deepEqual(texts, ["figure out taxes", "no due date at all"]);
  assert.ok(!someday.some((c: Commitment) => c.id === resolvable.id));
});

test("dropCommitment: retires by id; missing id returns null", () => {
  freshCwd("drop");
  const a = addCommitment({ text: "cancel the subscription" });
  addCommitment({ text: "renew the domain" });

  const dropped = dropCommitment(a.id);
  assert.ok(dropped);
  assert.equal(dropped!.status, "dropped");

  const open = openCommitments();
  assert.equal(open.length, 1);
  assert.ok(!open.some((c: Commitment) => c.id === a.id));

  assert.equal(dropCommitment("c-does-not-exist"), null);
});

test("readAll fail-open: malformed lines are skipped, good ones survive", () => {
  freshCwd("malformed");
  const good = addCommitment({ text: "buy groceries" });

  // Append junk + a valid-JSON-but-wrong-shape line + a second real one.
  const ledger = path.join(process.cwd(), "data", "commitments.jsonl");
  fs.appendFileSync(ledger, "this is not json at all\n");
  fs.appendFileSync(ledger, JSON.stringify({ id: 5, nope: true }) + "\n"); // wrong types
  const second = addCommitment({ text: "pick up the package" });

  const open = openCommitments();
  const ids = open.map((c: Commitment) => c.id).sort();
  assert.deepEqual(ids, [good.id, second.id].sort());
});

test("missing ledger fails open to empty for every reader", () => {
  freshCwd("empty");
  assert.deepEqual(openCommitments(), []);
  assert.deepEqual(dueCommitments(new Date()), []);
  assert.deepEqual(somedayCommitments(new Date()), []);
  assert.equal(resolveCommitment("anything"), null);
  assert.equal(dropCommitment("c-x"), null);
});
