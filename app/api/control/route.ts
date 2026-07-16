import { verifyControlToken } from "@/lib/control";
import { remember, recall } from "@/lib/memory";
import { listTerminals, stopTerminal, tailTerminal } from "@/lib/terminals";
import { close, findByName, listAgents, prompt, spawn } from "@/lib/agents/manager";
import { handsHealth, handsSnapshot } from "@/lib/hands";
import { isKillEngaged } from "@/lib/kill";
import { appendJournal } from "@/lib/journal";
import { fileConfirm } from "@/lib/confirm";
import { isOwner } from "@/lib/user-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Control plane — the CNVS cnvsctl analog. Agents (via bin/vidictl.mjs) call
 * back here to coordinate: inspect the fleet, share memory, hand tasks to
 * siblings, and spawn new agents. All ops require the X-Vidi-Control-Token
 * header (data/control-token). Loopback + token; act-mode agents already hold
 * equivalent Bash capability.
 *
 * The two outward-acting verbs are additionally gated (P2, closing B3/B4):
 *   - `shell` is owner-only AND proposable-but-approved — it PARKS a confirm
 *     action (nonce+token approval) instead of running arbitrary shell.
 *   - `hands` (GUI actuation) likewise PARKS a confirm instead of moving the
 *     mouse/keyboard straight away.
 * Neither runs without the separate P1 human approval.
 *
 * POST { op, ...args }. GET → state (also token-gated).
 */

function unauthorized() {
  return Response.json({ error: "invalid or missing control token" }, { status: 401 });
}

function state() {
  return {
    agents: listAgents().map((a) => ({
      name: a.name,
      provider: a.provider,
      status: a.status,
      turns: a.turns,
      tokensOut: a.tokens.output,
    })),
    memory: recall(undefined, 12),
    terminals: listTerminals().map((t) => ({ id: t.id, cmd: t.cmd, pid: t.pid })),
  };
}

export async function GET(req: Request) {
  if (!verifyControlToken(req)) return unauthorized();
  return Response.json(state());
}

export async function POST(req: Request) {
  if (!verifyControlToken(req)) return unauthorized();
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const op = body.op;

  try {
    switch (op) {
      case "state":
        return Response.json(state());

      case "remember": {
        if (typeof body.text !== "string" || !body.text.trim()) {
          return Response.json({ error: "text required" }, { status: 400 });
        }
        return Response.json({ ok: true, entry: remember(body.text, body.agent || "agent", body.tags) });
      }

      case "recall":
        return Response.json({ entries: recall(body.query, body.limit ?? 20) });

      case "spawn": {
        // H10 spawn-depth: body.spawnedBy is the calling agent's id (vidictl
        // forwards its own VIDI_AGENT_ID). spawn() refuses a spawn whose parent
        // is already depth>=1, so a spawned agent can't grow the fleet. A throw
        // surfaces as a 500 with the plain-language reason below.
        try {
          const agent = spawn({
            provider: body.provider,
            name: body.name,
            parentAgentId: typeof body.spawnedBy === "string" ? body.spawnedBy : undefined,
            // Sibling requested by another agent via the control plane — not
            // user-initiated, so it stays a background agent (off the Canvas).
            origin: "system",
          });
          return Response.json({ ok: true, agent: { name: agent.name, provider: agent.provider } });
        } catch (spawnError: any) {
          return Response.json(
            { ok: false, error: spawnError?.message || "spawn refused" },
            { status: 403 }
          );
        }
      }

      case "tell": {
        const target = findByName(body.name || "");
        if (!target) return Response.json({ error: `no agent named ${body.name}` }, { status: 404 });
        if (typeof body.task !== "string" || !body.task.trim()) {
          return Response.json({ error: "task required" }, { status: 400 });
        }
        const res = prompt(target.id, body.task);
        return Response.json(res.ok ? { ok: true, agent: target.name } : { error: res.reason }, {
          status: res.ok ? 200 : 409,
        });
      }

      case "close": {
        const target = findByName(body.name || "");
        if (!target) return Response.json({ error: `no agent named ${body.name}` }, { status: 404 });
        return Response.json({ ok: close(target.id) });
      }

      case "shell": {
        // B3 (P2): the control route's shell verb was raw arbitrary execution
        // with no human gate. Now it is proposable-but-approved AND owner-only:
        //  - owner check first — a non-owner second user can never run shell, even
        //    with the token, so this closes the residual B3 vector for her.
        //  - then it PARKS a confirm action instead of running it; the command
        //    only executes after the P1 token+nonce approval (the "shell"
        //    executor in lib/confirm-executors.ts runs startTerminal).
        if (!isOwner()) {
          return Response.json(
            { ok: false, error: "shell is owner-only" },
            { status: 403 }
          );
        }
        if (typeof body.cmd !== "string" || !body.cmd.trim()) {
          return Response.json({ error: "cmd required" }, { status: 400 });
        }
        const cmd = body.cmd.trim();
        const { pendingId, description } = fileConfirm({
          kind: "shell",
          payload: { cmd, cwd: typeof body.cwd === "string" ? body.cwd : undefined },
          description: `run a shell command: ${cmd.slice(0, 120)}`,
        });
        appendJournal({
          ts: Date.now(),
          threadId: "confirm",
          tool: "confirm-filed:shell",
          summary: `${description} (${pendingId})`,
        });
        // Nonce is intentionally NOT returned here — approval is a human tap in
        // the trusted UI, not something the proposing agent self-serves.
        return Response.json({ ok: true, pending: { pendingId, description } });
      }

      case "handsHealth":
        return Response.json(await handsHealth());

      case "handsSnapshot":
        return Response.json(await handsSnapshot());

      case "hands": {
        // B4 (P2): GUI actuation (click/type/…) moves the real mouse/keyboard —
        // an act-as-user outward action. It no longer fires straight from the
        // control route; it is proposable-but-approved, parked behind the P1
        // token+nonce tap gate (the "hands" executor relays it to the native
        // Hands server on approval). Kill switch still short-circuits, and the
        // proposal is journaled.
        if (isKillEngaged()) {
          return Response.json({ ok: false, error: "kill switch engaged" }, { status: 409 });
        }
        const act = (body.act ?? {}) as Record<string, unknown>;
        if (typeof act.action !== "string") {
          return Response.json({ ok: false, error: "act.action required" }, { status: 400 });
        }
        const { pendingId, description } = fileConfirm({
          kind: "hands",
          payload: act,
          description: `control the Mac: ${act.action}`,
        });
        appendJournal({
          ts: Date.now(),
          threadId: "confirm",
          tool: `confirm-filed:hands:${act.action}`,
          summary: JSON.stringify(act).slice(0, 200),
        });
        return Response.json({ ok: true, pending: { pendingId, description } });
      }

      case "terminals":
        return Response.json({ terminals: listTerminals() });

      case "terminalLog":
        return Response.json({ log: tailTerminal(body.id, body.lines ?? 40) });

      case "stopTerminal":
        return Response.json({ ok: stopTerminal(body.id) });

      default:
        return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
    }
  } catch (e: any) {
    return Response.json({ error: e?.message || "control op failed" }, { status: 500 });
  }
}
