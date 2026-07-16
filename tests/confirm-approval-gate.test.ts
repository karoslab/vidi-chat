import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P1 acceptance — the 4a A3 negative test, VERBATIM (the security-tier plan
 * §P1 / the fixit plan §6.1 A3). Approving a parked confirm action requires BOTH layers of
 * the B1 fix:
 *   Layer B — a valid control token on the request (verifyControlToken), the
 *             thing a blind local POST forging {"transcript":"confirm"} lacks.
 *   Layer A — the parked action's per-command nonce (checked in confirmPending).
 *
 * The three cases the audit demands:
 *   1. forged POST WITHOUT the token → rejected (no run)
 *   2. correct token but WRONG nonce → rejected (no run)
 *   3. token AND correct nonce → approves (runs exactly once)
 *
 * runVoiceTurn + the route use "@/" alias imports plain `node --test` can't
 * resolve, so — exactly as kill-clear-auth.test.ts does — we drive the REAL
 * verifyControlToken + confirm lib through a harness that mirrors the route's
 * token read and voice-turn.ts's confirm-intercept gate verbatim.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-approval-gate-")));
const { getControlToken, verifyControlToken } = await import("../lib/control.ts");
const { requestConfirm, hasPending, cancelPending, confirmPending } = await import(
  "../lib/confirm.ts"
);

const TOKEN = getControlToken();
const T0 = 1_000_000_000_000;

/** Build the transcript POST the Swift app / an attacker would send. */
function post(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:4183/api/voice-command", {
    method: "POST",
    headers,
    body: JSON.stringify({ transcript: "confirm" }),
  });
}

/**
 * The approval path, verbatim in behavior: the route derives controlAuthorized
 * from verifyControlToken(req) and reads body.nonce; voice-turn.ts's confirm
 * intercept refuses without a valid token, else calls confirmPending with the
 * nonce. Returns whether the parked action actually RAN.
 */
async function approve(
  req: Request,
  nonce: string | undefined,
  now: number
): Promise<{ ran: boolean }> {
  const controlAuthorized = verifyControlToken(req);
  if (!controlAuthorized) return { ran: false }; // Layer B refusal
  const res = await confirmPending(now, { nonce });
  return { ran: res.ran };
}

/** Park a fresh risky action and hand back its nonce + a run counter. */
function park(now: number) {
  const state = { runs: 0 };
  const { nonce } = requestConfirm(
    {
      kind: "risky",
      description: "do the risky thing",
      execute: async () => {
        state.runs++;
        return "did it";
      },
    },
    { now }
  );
  return { nonce, state };
}

test("A3.1 — forged POST WITHOUT the control token → rejected, action never runs", async () => {
  cancelPending(T0);
  const { nonce, state } = park(T0);
  assert.equal(hasPending(T0), true);

  // The B1 forge: a local process POSTs {"transcript":"confirm"} (even guessing
  // the nonce) but has NO control token.
  const res = await approve(post(), nonce, T0);
  assert.equal(res.ran, false);
  assert.equal(state.runs, 0, "a tokenless approval must not fire the parked action");
  assert.equal(hasPending(T0), true, "and it must not consume the slot");
  cancelPending(T0);
});

test("A3.2 — correct token but WRONG nonce → rejected, action never runs", async () => {
  cancelPending(T0);
  const { nonce, state } = park(T0);

  const res = await approve(post({ "x-vidi-control-token": TOKEN }), nonce + "tampered", T0);
  assert.equal(res.ran, false);
  assert.equal(state.runs, 0, "a valid token can't approve without the right nonce");
  assert.equal(hasPending(T0), true, "the wrong-nonce attempt leaves the slot intact");
  cancelPending(T0);
});

test("A3.3 — token AND correct nonce → approves, action runs exactly once", async () => {
  cancelPending(T0);
  const { nonce, state } = park(T0);

  const res = await approve(post({ "x-vidi-control-token": TOKEN }), nonce, T0);
  assert.equal(res.ran, true);
  assert.equal(state.runs, 1, "only both-valid runs the action");
  assert.equal(hasPending(T0), false, "and the single-shot slot is cleared");

  // Single-shot: a replay with the same token+nonce is a no-op.
  const replay = await approve(post({ "x-vidi-control-token": TOKEN }), nonce, T0);
  assert.equal(replay.ran, false);
  assert.equal(state.runs, 1);
});
