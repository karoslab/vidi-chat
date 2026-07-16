import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isKillEngaged, registerRun } from "../kill.ts";
import { appendQuota } from "../quota.ts";
import { WORKSPACE_ROOT } from "../workspace.ts";
import { scrubbedChildEnv } from "../child-env.ts";
import { getUserConfig } from "../user-config.ts";
import { userRulesBlock } from "../user-rules.ts";
import { requestConfirm } from "../confirm.ts";
import type {
  BrainProvider,
  ProviderStreamEvent,
  SendMessageArgs,
} from "./types.ts";

/**
 * ACP (Agent Client Protocol) provider — the client side of Zed's editor↔agent
 * protocol. It spawns a configured ACP agent binary and drives one prompt turn
 * over newline-delimited JSON-RPC 2.0 on stdio, mapping the agent's session/update
 * notifications onto our provider event shape.
 *
 * Unlike claude/codex/grok, ACP has NO default binary: the provider is inert
 * until ACP_AGENT_BIN names an executable (lib/providers/index.ts only registers
 * it when configured). ACP_AGENT_ARGS (optional, space-separated) supplies any
 * subcommand/flags the agent needs to speak ACP (e.g. `--experimental-acp`).
 *
 * Protocol (verified against agentclientprotocol.com — protocol version 1,
 * ndjson framing over stdio; see the PR body's Documentation sources):
 *   - client → `initialize` {protocolVersion, clientCapabilities}. We advertise
 *     NO filesystem/terminal capability (fs.readTextFile/writeTextFile=false):
 *     the client never lets the agent read or write through it, so the agent's
 *     own tools are its only side-effect path — and those surface as tool_call +
 *     `session/request_permission`, which we NEVER auto-approve (see below).
 *   - client → `session/new` {cwd, mcpServers} → {sessionId}; or, when resuming
 *     and the agent advertised loadSession, `session/load` {sessionId} (its
 *     history replay is streamed BEFORE the response and is deliberately not
 *     surfaced as new deltas — see promptSent).
 *   - client → `session/prompt` {sessionId, prompt:[content blocks]} → {stopReason}.
 *   - agent → `session/update` notifications: agent_message_chunk (→ delta),
 *     agent_thought_chunk (→ one honest reasoning signal, never the text),
 *     tool_call (→ tool event); tool_call_update/plan are ignored.
 *   - agent → `session/request_permission` request: NEVER auto-approved. We
 *     surface it (a tool event + a filed confirm via the existing approval flow)
 *     and answer with the reject option (or cancelled). A synchronous editor
 *     permission dialog has no place in a streamed voice turn, so the honest
 *     in-turn answer is "no"; the human grants it out of band via the confirm
 *     queue on a later turn.
 *
 * Like codex/grok this runs read-only in effect (every write the agent proposes
 * is rejected), authenticates off the agent's own on-disk config (scrubbed env,
 * no API keys), and reports no token usage — the ledger records the turn without
 * token fields. Persona + the owner's standing rules are prepended to the first
 * prompt (no system-prompt method in core ACP); resumed turns carry them already.
 */

const REPO_ROOT = path.resolve(process.cwd());
const PERSONA_FILE = path.join(REPO_ROOT, "VIDI_PERSONA.md");
const WORK_DIR = WORKSPACE_ROOT;
const INACTIVITY_MS = 120_000;
/** ACP protocol version this client speaks (agentclientprotocol.com: integer 1). */
const ACP_PROTOCOL_VERSION = 1;

/** The configured ACP agent binary, or null when unset/missing. NO default —
 *  the provider is opt-in behind an explicit config entry. Read at call time so
 *  available() reflects live config. */
export function acpBin(): string | null {
  const bin = process.env.ACP_AGENT_BIN;
  if (bin && existsSync(bin)) return bin;
  return null;
}

/** Extra argv for the agent binary (ACP_AGENT_ARGS, space-separated). Many ACP
 *  agents need a subcommand/flag to enter ACP mode; this supplies it without a
 *  hardcoded per-agent table. */
export function acpAgentArgs(): string[] {
  const raw = process.env.ACP_AGENT_ARGS;
  if (!raw || !raw.trim()) return [];
  return raw.trim().split(/\s+/);
}

/** True iff an ACP agent binary is explicitly configured (no default). */
export function acpConfigured(): boolean {
  return acpBin() !== null;
}

/** Pull the text out of an ACP ContentBlock (only the text variant carries any). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content; // defensive
  if (content && typeof content === "object" && (content as any).type === "text") {
    const t = (content as any).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

export const acpProvider: BrainProvider = {
  id: "acp",
  label: "ACP Agent",
  // ACP agents vary and core ACP has no model/effort selection, so a single
  // config-driven pseudo-model — the concrete agent is chosen by ACP_AGENT_BIN.
  models: [{ id: "default", label: "ACP Agent", default: true }],

  async available() {
    if (!acpConfigured()) {
      return {
        ok: false,
        reason:
          "No ACP agent configured — set ACP_AGENT_BIN to the agent binary (and ACP_AGENT_ARGS if it needs an ACP flag).",
      };
    }
    return { ok: true };
  },

  async *sendMessage(args: SendMessageArgs): AsyncGenerator<ProviderStreamEvent> {
    if (isKillEngaged()) {
      yield {
        type: "error",
        message:
          "kill switch is engaged — say 'clear the kill switch' or delete data/KILL",
      };
      return;
    }
    const bin = acpBin();
    if (!bin) {
      yield {
        type: "error",
        message:
          "No ACP agent configured — set ACP_AGENT_BIN to the agent binary.",
      };
      return;
    }

    // Persona + the owner's standing rules ride the first prompt (no system-prompt
    // method in core ACP); resumed turns already carry them in context. Same
    // shape as codex/grok so the rules block lands for every provider.
    let promptText = args.userMessage;
    const resuming = Boolean(args.priorProviderSessionId);
    if (!resuming) {
      let persona = "";
      try {
        persona = readFileSync(PERSONA_FILE, "utf8");
      } catch {
        /* persona file missing — proceed without it */
      }
      const system = [userRulesBlock(), persona, args.extraSystemText]
        .filter(Boolean)
        .join("\n\n");
      if (system) {
        promptText = `<system>\n${system}\n</system>\n\n${getUserConfig().displayName} says: ${args.userMessage}`;
      }
    }

    const startedAt = Date.now();
    const child = spawn(bin, acpAgentArgs(), {
      cwd: WORK_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      // args.childEnv carries the fleet's VIDI_AGENT_ID/DEPTH stamp (H10).
      // Tier-2 (S-env): scrubbed allowlisted env, not the full process.env — no
      // proxy key / cloud credential reaches the agent; it authenticates off its
      // own on-disk config, same contract as the CLI providers.
      env: scrubbedChildEnv(args.childEnv ?? {}),
    });

    // Kill-switch registry — engageKill() SIGKILLs everything registered.
    const unregister = child.pid
      ? registerRun(
          {
            pid: child.pid,
            threadId: args.threadId,
            provider: "acp",
            startedAt: Date.now(),
          },
          child
        )
      : () => {};

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    // --- JSON-RPC over ndjson stdio -----------------------------------------
    let nextId = 1;
    const pendingRpc = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const writeMessage = (obj: unknown): void => {
      try {
        // stdin is a pipe (stdio[0]==="pipe"); `?.` satisfies strict null checks.
        child.stdin?.write(JSON.stringify(obj) + "\n");
      } catch {
        /* child gone — the awaiting rpc rejects on close */
      }
    };
    const rpc = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
        writeMessage({ jsonrpc: "2.0", id, method, params });
      });
    };
    const respond = (id: unknown, result: unknown): void =>
      writeMessage({ jsonrpc: "2.0", id, result });
    const respondError = (id: unknown, code: number, message: string): void =>
      writeMessage({ jsonrpc: "2.0", id, error: { code, message } });

    // --- generator plumbing --------------------------------------------------
    let sessionId: string | null = null;
    let accumulated = "";
    let reasoned = false;
    let promptSent = false; // gate: ignore session/load history replay
    let result: { kind: "done"; stopReason: string | null } | { kind: "error"; message: string } | null = null;

    const queue: ProviderStreamEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let exitCode: number | null = null;
    const push = (ev: ProviderStreamEvent) => {
      queue.push(ev);
      notify?.();
    };

    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > INACTIVITY_MS) {
        child.kill("SIGKILL");
        push({
          type: "error",
          message: "ACP agent produced no output for 2 minutes — killed.",
        });
        finished = true;
        notify?.();
      }
    }, 5_000);

    // Abort (the explicit stop button): best-effort cancel the ACP turn, kill the
    // child, and end with a normal `done` carrying the partial text, flagged
    // `stopped` — a stop is not a failure.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      if (sessionId) writeMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      push({ type: "done", providerSessionId: sessionId, fullText: accumulated, stopped: true });
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      notify?.();
    };
    if (args.signal?.aborted) onAbort();
    else args.signal?.addEventListener("abort", onAbort, { once: true });

    // Never auto-approve. Surface the request (a tool event + a filed confirm on
    // the existing approval flow) and answer with the reject option, or cancelled
    // when the agent offered none. The confirm is depth-1 by design (newest ask
    // wins); its executor is honest — approving it can't retroactively grant a
    // finished turn, so it tells the owner to re-ask.
    const handlePermission = (id: unknown, params: any): void => {
      const toolCall = (params && params.toolCall) || {};
      const label =
        (typeof toolCall.toolName === "string" && toolCall.toolName) ||
        (typeof toolCall.title === "string" && toolCall.title) ||
        "an action";
      push({
        type: "tool",
        tool: String(label),
        summary: "permission requested — declined (approve it out loud to run it)",
      });
      try {
        requestConfirm({
          kind: "acp-permission",
          description: `The ACP agent asked to run ${label}. I did not auto-approve it.`,
          execute: async () =>
            `The ACP agent's request to run ${label} was declined during that turn. Ask me again to run it.`,
        });
      } catch {
        /* surfacing must never break the turn */
      }
      const options = Array.isArray(params?.options) ? params.options : [];
      const reject = options.find(
        (o: any) => o && typeof o.kind === "string" && o.kind.startsWith("reject")
      );
      if (reject && typeof reject.optionId === "string") {
        respond(id, { outcome: { outcome: "selected", optionId: reject.optionId } });
      } else {
        respond(id, { outcome: { outcome: "cancelled" } });
      }
    };

    const handleUpdate = (update: any): void => {
      if (!update || typeof update !== "object") return;
      // A loadSession agent replays the ENTIRE prior conversation via
      // session/update BEFORE the session/load response returns — message
      // chunks, thoughts, AND tool calls. None of it is output of THIS prompt,
      // so gate every history-bearing update on promptSent: replayed reasoning
      // must not re-set the reasoning flag and replayed tool calls must not
      // surface as fresh tool events.
      if (!promptSent) return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = contentText(update.content);
          if (text) {
            accumulated += text;
            push({ type: "delta", text });
          }
          break;
        }
        case "agent_thought_chunk": {
          // Honest reasoning signal — emit once per turn, never the thought text
          // (matches the claude/grok providers' UI contract).
          if (!reasoned) {
            reasoned = true;
            push({ type: "reasoning", reasoned: true });
          }
          break;
        }
        case "tool_call": {
          const name =
            (typeof update.toolName === "string" && update.toolName) ||
            (typeof update.title === "string" && update.title) ||
            "tool";
          push({
            type: "tool",
            tool: String(name),
            summary: typeof update.title === "string" ? update.title : "",
          });
          break;
        }
        // tool_call_update / plan / others: no separate provider event.
      }
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      lastActivity = Date.now();
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return; // skip any stray agent stdout logs
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      // A response to one of OUR requests (has id, no method).
      if (msg.method === undefined && msg.id !== undefined) {
        const p = pendingRpc.get(msg.id);
        if (p) {
          pendingRpc.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(String(msg.error?.message ?? "ACP request failed")));
          } else {
            p.resolve(msg.result);
          }
        }
        return;
      }
      // Notifications / requests FROM the agent.
      if (msg.method === "session/update") {
        handleUpdate(msg.params?.update);
        return;
      }
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        handlePermission(msg.id, msg.params);
        return;
      }
      // Any other agent→client request (fs/*, terminal/*): we advertised no such
      // capability, so answer method-not-found rather than let the agent hang.
      if (msg.id !== undefined) {
        respondError(msg.id, -32601, `ACP client does not implement ${msg.method}`);
      }
    });

    child.on("close", (code) => {
      exitCode = code;
      // Unblock any in-flight rpc so drive() can settle.
      for (const [, p] of pendingRpc) p.reject(new Error("ACP agent exited"));
      pendingRpc.clear();
      finished = true;
      clearInterval(watchdog);
      notify?.();
    });
    child.on("error", (err) => {
      push({ type: "error", message: `failed to spawn ACP agent: ${err.message}` });
      finished = true;
      clearInterval(watchdog);
      notify?.();
    });

    // Drive the ACP lifecycle. Deltas/tools stream through the queue from the rl
    // handler while this awaits each request/response; it sets `result` and marks
    // finished, then the loop below builds the terminal event.
    const drive = async () => {
      try {
        const init: any = await rpc("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: "vidi-chat", version: "0.1.0" },
        });
        const canLoad = init?.agentCapabilities?.loadSession === true;

        if (resuming && canLoad) {
          try {
            await rpc("session/load", {
              sessionId: args.priorProviderSessionId,
              cwd: WORK_DIR,
              mcpServers: [],
            });
            sessionId = args.priorProviderSessionId ?? null;
          } catch {
            // Agent couldn't reload the stored session (it may not persist across
            // process restarts) — start fresh; the new id replaces the old.
            const ns: any = await rpc("session/new", { cwd: WORK_DIR, mcpServers: [] });
            sessionId = typeof ns?.sessionId === "string" ? ns.sessionId : null;
          }
        } else {
          const ns: any = await rpc("session/new", { cwd: WORK_DIR, mcpServers: [] });
          sessionId = typeof ns?.sessionId === "string" ? ns.sessionId : null;
        }
        if (!sessionId) throw new Error("ACP agent returned no session id");

        promptSent = true;
        const pr: any = await rpc("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText }],
        });
        const stopReason = typeof pr?.stopReason === "string" ? pr.stopReason : null;
        result = { kind: "done", stopReason };
      } catch (err) {
        if (aborted) return; // onAbort already emitted the terminal done
        const detail = err instanceof Error ? err.message : String(err);
        result = {
          kind: "error",
          message:
            stderrTail.trim() && exitCode !== 0
              ? `ACP agent error: ${(detail + " | " + stderrTail.trim()).slice(0, 500)}`
              : `ACP agent error: ${detail.slice(0, 500)}`,
        };
      } finally {
        finished = true;
        notify?.();
      }
    };
    void drive();

    try {
      while (true) {
        while (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          if (ev.type === "error") return;
        }
        if (finished) break;
        await new Promise<void>((resolve) => (notify = resolve));
        notify = null;
      }

      // onAbort already yielded its own done (with the partial text) and set
      // finished — don't append a ledger row or a contradicting terminal event.
      if (aborted) return;

      // Ledger: core ACP reports no token counts, so record that a turn happened
      // (provider/model/mode + duration) without token fields — same as grok.
      appendQuota({
        ts: Date.now(),
        provider: "acp",
        threadId: args.threadId,
        model: "default",
        // Effectively read-only (every write is rejected), so "chat" like grok.
        mode: "chat",
        durationMs: Date.now() - startedAt,
        numTurns: 1,
      });

      if (result?.kind === "error") {
        yield { type: "error", message: result.message };
        return;
      }
      yield {
        type: "done",
        providerSessionId: sessionId,
        fullText: accumulated,
        ...(result?.kind === "done" && result.stopReason === "cancelled"
          ? { stopped: true as const }
          : {}),
      };
    } finally {
      clearInterval(watchdog);
      args.signal?.removeEventListener("abort", onAbort);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      for (const [, p] of pendingRpc) p.reject(new Error("turn ended"));
      pendingRpc.clear();
      unregister();
    }
  },
};
