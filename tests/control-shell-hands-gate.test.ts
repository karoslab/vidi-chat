import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P2 — the control route's outward-acting verbs (closing B4, finishing B3).
 *
 *   - `shell` (B3): owner-only AND proposable-but-approved. A non-owner is 403
 *     (never runs shell even with the token); an owner does NOT execute the
 *     command — it PARKS a confirm behind the P1 approval gate. No terminal is
 *     spawned at request time.
 *   - `hands` (B4): GUI actuation no longer fires from the control route — it
 *     PARKS a confirm instead of moving the mouse/keyboard.
 *
 * The route uses "@/" imports plain `node --test` can't resolve, so we drive the
 * REAL fileConfirm + isOwner + terminal registry through the route's exact
 * shell/hands branch logic (same technique as kill-clear-auth.test.ts). isOwner
 * reads VIDI_OWNER live, so we toggle it per case.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-shell-hands-gate-")));
const { fileConfirm, hasPending, cancelPending, confirmPending } = await import(
  "../lib/confirm.ts"
);
const { isOwner } = await import("../lib/user-config.ts");
const { listTerminals } = await import("../lib/terminals.ts");
const { isKillEngaged, engageKill, clearKill } = await import("../lib/kill.ts");

const T0 = 1_000_000_000_000;

/** The route's `shell` branch, verbatim in behavior. */
function shellBranch(body: { cmd?: unknown; cwd?: unknown }): { status: number; parked: boolean } {
  if (!isOwner()) return { status: 403, parked: false };
  if (typeof body.cmd !== "string" || !body.cmd.trim()) return { status: 400, parked: false };
  const cmd = body.cmd.trim();
  fileConfirm({
    kind: "shell",
    payload: { cmd, cwd: typeof body.cwd === "string" ? body.cwd : undefined },
    description: `run a shell command: ${cmd.slice(0, 120)}`,
  });
  return { status: 200, parked: true };
}

/** The route's `hands` branch, verbatim in behavior. */
function handsBranch(body: { act?: Record<string, unknown> }): { status: number; parked: boolean } {
  if (isKillEngaged()) return { status: 409, parked: false };
  const act = (body.act ?? {}) as Record<string, unknown>;
  if (typeof act.action !== "string") return { status: 400, parked: false };
  fileConfirm({ kind: "hands", payload: act, description: `control the Mac: ${act.action}` });
  return { status: 200, parked: true };
}

test("shell as a NON-owner → 403, no command parked or run", () => {
  cancelPending(T0);
  process.env.VIDI_OWNER = "0";
  assert.equal(isOwner(), false);
  const res = shellBranch({ cmd: "rm -rf ~" });
  assert.equal(res.status, 403);
  assert.equal(hasPending(T0), false, "a non-owner can't even park a shell command");
  assert.equal(listTerminals().length, 0, "nothing is executed");
});

test("shell as the OWNER → parks a confirm, does NOT execute (no terminal spawned)", () => {
  cancelPending(T0);
  process.env.VIDI_OWNER = "1";
  assert.equal(isOwner(), true);
  const before = listTerminals().length;
  const res = shellBranch({ cmd: "echo hello" });
  assert.equal(res.status, 200);
  assert.equal(res.parked, true);
  assert.equal(hasPending(T0), true, "the shell command is parked behind the approval gate");
  assert.equal(
    listTerminals().length,
    before,
    "the command is NOT run at request time — approval runs it, not the control route"
  );
  cancelPending(T0);
  delete process.env.VIDI_OWNER;
});

test("hands → parks a confirm instead of actuating the GUI", () => {
  cancelPending(T0);
  const res = handsBranch({ act: { action: "click", x: 10, y: 20 } });
  assert.equal(res.status, 200);
  assert.equal(res.parked, true);
  assert.equal(hasPending(T0), true, "GUI actuation is parked behind the approval gate");
  cancelPending(T0);
});

test("hands with the kill switch engaged is refused before parking", () => {
  cancelPending(T0);
  engageKill("test");
  const res = handsBranch({ act: { action: "click" } });
  assert.equal(res.status, 409);
  assert.equal(hasPending(T0), false);
  clearKill();
});

test("hands parked BEFORE an emergency stop does NOT actuate when approved after it", async () => {
  // The kill switch must stay a real emergency stop: an action parked while the
  // switch was disengaged, then approved AFTER it engages (within the 120s TTL),
  // must not move the mouse/keyboard. The control route checks kill at PARK time;
  // this proves the `hands` EXECUTOR re-checks at ACTUATION time. We drive the
  // REAL registered executor via confirmPending (loaded on first confirm), so a
  // regression in the executor — not a harness mirror — fails this test.
  cancelPending(T0);
  clearKill();

  // 1) Park with the kill switch DISENGAGED (park-time check passes).
  const { nonce } = fileConfirm(
    { kind: "hands", payload: { action: "click", x: 5, y: 5 }, description: "control the Mac: click" },
    { now: T0 }
  );
  assert.equal(hasPending(T0), true);

  // 2) Emergency stop engages in the approval window.
  engageKill("emergency stop after park");
  assert.equal(isKillEngaged(), true);

  // 3) Approve with the valid nonce. The executor must fail CLOSED: a spoken
  //    refusal, never an actuation. (Were it to actuate, with no Hands server it
  //    would instead say it couldn't reach the Mac controls — a different line.)
  const r = await confirmPending(T0, { nonce });
  assert.equal(r.ran, true);
  assert.match(
    r.text,
    /kill switch is engaged/i,
    "a hands action approved under an engaged kill switch must be refused, not actuated"
  );

  clearKill();
});
