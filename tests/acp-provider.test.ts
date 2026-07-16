import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * ACP provider (lib/providers/acp.ts). Exercised against a fake ACP agent
 * process wired via ACP_AGENT_BIN — never a real Zed agent. The fake speaks the
 * real Agent Client Protocol: newline-delimited JSON-RPC 2.0 over stdio with the
 * documented method set (initialize / session/new / session/load / session/prompt)
 * and the session/update notification variants (agent_message_chunk /
 * agent_thought_chunk / tool_call), plus a client-bound session/request_permission
 * request so the "never auto-approve" gate can be asserted.
 *
 * Protocol shapes verified against agentclientprotocol.com (protocol version 1,
 * ndjson framing) — see the PR body's Documentation sources.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-acp-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const MSG_LOG = path.join(tmp, "acp-messages.json");
const PERM_LOG = path.join(tmp, "acp-permission.json");
const FAKE_AGENT = path.join(tmp, "fake-acp-agent.mjs");
process.env.ACP_AGENT_BIN = FAKE_AGENT;

// The fake agent: a minimal ACP-compliant agent over ndjson JSON-RPC.
//  - logs every received message to MSG_LOG (so initialize + prompt params can
//    be asserted) and resets PERM_LOG at startup.
//  - initialize → advertises loadSession so resume exercises session/load.
//  - session/new → returns a fresh session id; session/load → echoes the id back
//    (and replays one history chunk that the client MUST NOT surface as a delta).
//  - session/prompt → branches on the prompt text:
//      * "STALL"      → one chunk then hang (for the abort test).
//      * "PERMISSION" → a tool_call, then a client-bound session/request_permission
//                       offering an allow AND a reject option; on the client's
//                       response it logs the outcome and finishes.
//      * otherwise    → a thought, a tool_call, two message chunks, then a result.
fs.writeFileSync(
  FAKE_AGENT,
  `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const MSG_LOG = ${JSON.stringify(MSG_LOG)};
const PERM_LOG = ${JSON.stringify(PERM_LOG)};
fs.writeFileSync(PERM_LOG, "");
const received = [];
const logMsg = (m) => { received.push(m); fs.writeFileSync(MSG_LOG, JSON.stringify(received)); };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const notif = (sid, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });
let pendingPrompt = null; // { id, sid } while awaiting a permission response
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  logMsg(msg);
  const { id, method, params } = msg;
  // A response to our session/request_permission request (no method, has result).
  if (method === undefined && id !== undefined && msg.result !== undefined) {
    fs.writeFileSync(PERM_LOG, JSON.stringify(msg.result));
    if (pendingPrompt) {
      const { id: promptId, sid } = pendingPrompt;
      pendingPrompt = null;
      notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after-perm" } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
    return;
  }
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "acp-sess-1" } });
  } else if (method === "session/load") {
    // Replay prior-conversation history BEFORE returning — a message chunk, a
    // thought, AND a tool call. The client must surface NONE of it (it's not
    // output of the new prompt).
    notif(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD-HISTORY" } });
    notif(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: "OLD-THOUGHT" });
    notif(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "old_1", title: "Old tool", toolName: "old_history_tool", kind: "read", status: "completed", input: {} });
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "session/prompt") {
    const sid = params.sessionId;
    const promptText = JSON.stringify(params.prompt);
    if (promptText.includes("STALL")) {
      notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      setInterval(() => {}, 1000); // hang until SIGKILLed by the abort
      return;
    }
    if (promptText.includes("QUIET")) {
      // A new turn that produces ONLY message chunks — no thought, no tool call
      // — so the resume test can prove replayed history (thought + tool_call)
      // never surfaces: any reasoning/tool event on this turn is leaked replay.
      notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
      notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    if (promptText.includes("PERMISSION")) {
      notif(sid, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Write config", toolName: "write_file", kind: "edit", status: "pending", input: {} });
      pendingPrompt = { id, sid };
      send({
        jsonrpc: "2.0",
        id: 9001,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          toolCall: { toolCallId: "call_1", title: "Write config", toolName: "write_file" },
          options: [
            { optionId: "allow-1", name: "Allow", kind: "allow_once" },
            { optionId: "reject-1", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    notif(sid, { sessionUpdate: "agent_thought_chunk", content: "thinking about it" });
    notif(sid, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Reading file", toolName: "read_file", kind: "read", status: "pending", input: {} });
    notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
    notif(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    // Any client-implemented method we don't model: answer so nothing hangs.
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not implemented in fake" } });
  }
});
`,
  { mode: 0o755 }
);

const { acpProvider, acpConfigured } = await import("../lib/providers/acp.ts");

async function collect(
  args: Parameters<typeof acpProvider.sendMessage>[0]
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of acpProvider.sendMessage(args)) events.push(ev);
  return events;
}

const messages = (): any[] => JSON.parse(fs.readFileSync(MSG_LOG, "utf8"));
const byMethod = (m: string) => messages().filter((x) => x.method === m);

test("id/label/models — a single config-driven model, no default binary", () => {
  assert.equal(acpProvider.id, "acp");
  assert.equal(acpProvider.label, "ACP Agent");
  assert.equal(acpProvider.models.length, 1);
  assert.equal(acpProvider.models[0].default, true);
});

test("available()/acpConfigured() reflect the explicit ACP_AGENT_BIN config", async () => {
  assert.equal(acpConfigured(), true);
  assert.equal((await acpProvider.available()).ok, true);

  // Unset the config: no default binary, so the provider is unavailable.
  const saved = process.env.ACP_AGENT_BIN;
  delete process.env.ACP_AGENT_BIN;
  assert.equal(acpConfigured(), false);
  const avail = await acpProvider.available();
  assert.equal(avail.ok, false);
  assert.ok(avail.reason && avail.reason.length > 0);
  process.env.ACP_AGENT_BIN = saved;
});

test("unconfigured sendMessage yields a single error, never spawns", async () => {
  const saved = process.env.ACP_AGENT_BIN;
  delete process.env.ACP_AGENT_BIN;
  const events = await collect({ threadId: "u1", userMessage: "hi" });
  process.env.ACP_AGENT_BIN = saved;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
});

test("full lifecycle: initialize(v1, fs off) → session/new → prompt streams deltas, reasoning, tool, done", async () => {
  const events = await collect({ threadId: "t1", userMessage: "hi there" });

  // initialize handshake: protocol version 1, and NO filesystem/terminal
  // capability offered to the agent (safest posture — the client never lets the
  // agent read/write through it; its own tools surface as permission requests).
  const init = byMethod("initialize")[0];
  assert.ok(init, "an initialize request must be sent");
  assert.equal(init.params.protocolVersion, 1);
  assert.equal(init.params.clientCapabilities.fs.readTextFile, false);
  assert.equal(init.params.clientCapabilities.fs.writeTextFile, false);

  // session/new with an ABSOLUTE cwd + an mcpServers array (both required).
  const newSess = byMethod("session/new")[0];
  assert.ok(newSess, "a session/new request must be sent");
  assert.ok(path.isAbsolute(newSess.params.cwd), "cwd must be absolute");
  assert.ok(Array.isArray(newSess.params.mcpServers));
  assert.equal(byMethod("session/load").length, 0, "fresh turn must not load");

  // agent_message_chunk → deltas, in order.
  const deltas = events.filter((e) => e.type === "delta");
  assert.deepEqual(
    deltas.map((d) => (d.type === "delta" ? d.text : "")),
    ["Hello", " world"]
  );

  // agent_thought_chunk → ONE honest reasoning signal, never the thought text.
  const reasoning = events.filter((e) => e.type === "reasoning");
  assert.equal(reasoning.length, 1);
  assert.ok(!JSON.stringify(events).includes("thinking about it"));

  // tool_call → a tool event.
  const tools = events.filter((e) => e.type === "tool");
  assert.equal(tools.length, 1);
  assert.ok(tools[0].type === "tool" && tools[0].tool === "read_file");

  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.fullText, "Hello world");
  assert.equal(done.providerSessionId, "acp-sess-1");
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("the owner's standing rules + a text content block carry the prompt (user-rules.ts)", async () => {
  const { USER_RULES_HEADING, _resetUserRulesCache } = await import(
    "../lib/user-rules.ts"
  );
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-acp-home-"));
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".claude", "CLAUDE.md"),
    "RULE: say I don't know rather than guess."
  );
  process.env.HOME = fakeHome;
  _resetUserRulesCache();

  await collect({ threadId: "rules1", userMessage: "hi" });
  const prompt = byMethod("session/prompt")[0];
  const block = prompt.params.prompt[0];
  assert.equal(block.type, "text");
  assert.ok(block.text.includes(USER_RULES_HEADING), "rules heading must be in the prompt block");
  assert.ok(block.text.includes("say I don't know"), "rules body must be present");
});

test("permission requests are NEVER auto-approved: the reject option is selected", async () => {
  const events = await collect({ threadId: "perm1", userMessage: "please PERMISSION" });

  // The client's response to session/request_permission must select the REJECT
  // option — never the allow option, never a bare grant.
  const outcome = JSON.parse(fs.readFileSync(PERM_LOG, "utf8"));
  assert.equal(outcome.outcome.outcome, "selected");
  assert.equal(outcome.outcome.optionId, "reject-1");
  assert.notEqual(outcome.outcome.optionId, "allow-1");

  // It is surfaced as a tool event so the transcript shows the denied action.
  const tools = events.filter((e) => e.type === "tool");
  assert.ok(tools.some((t) => t.type === "tool" && /write_file|write config/i.test(t.tool + t.summary)));

  // The turn still completes with the post-permission message.
  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.ok(done.fullText.includes("after-perm"));
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("permission requests are surfaced through the confirm/approval flow", async () => {
  const { hasPending, cancelPending } = await import("../lib/confirm.ts");
  cancelPending(); // clean slot
  await collect({ threadId: "perm2", userMessage: "do PERMISSION" });
  assert.equal(hasPending(), true, "the ACP permission must be filed into the confirm queue");
  cancelPending();
});

test("resume: session/load replay (message, thought, AND tool_call) never surfaces", async () => {
  // The resumed turn is a QUIET stream (only message chunks), so ANY reasoning
  // or tool event that appears is leaked session/load history — this is what
  // catches an incomplete replay gate that only suppresses text.
  const events = await collect({
    threadId: "t2",
    userMessage: "and then? QUIET",
    priorProviderSessionId: "acp-sess-prior",
  });

  const load = byMethod("session/load")[0];
  assert.ok(load, "resume must send session/load");
  assert.equal(load.params.sessionId, "acp-sess-prior");
  assert.equal(byMethod("session/new").length, 0, "resume must not open a new session");

  // Only the NEW turn's message chunks — replayed history is fully suppressed.
  const deltas = events.filter((e) => e.type === "delta").map((d) => (d.type === "delta" ? d.text : ""));
  assert.deepEqual(deltas, ["Hello", " world"]);
  assert.ok(!deltas.includes("OLD-HISTORY"), "replayed message chunk must not surface");

  // Replayed agent_thought_chunk must NOT re-set the reasoning signal, and the
  // replayed tool_call must NOT surface as a fresh tool event.
  assert.equal(
    events.filter((e) => e.type === "reasoning").length,
    0,
    "replayed thought must not emit a reasoning signal"
  );
  const tools = events.filter((e) => e.type === "tool");
  assert.equal(tools.length, 0, "replayed tool_call must not surface as a tool event");
  assert.ok(
    !tools.some((t) => t.type === "tool" && t.tool === "old_history_tool"),
    "the replayed tool must never appear"
  );

  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.providerSessionId, "acp-sess-prior");
});

test("aborting mid-stream persists the partial text as a done flagged stopped — no error", async () => {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const ev of acpProvider.sendMessage({
    threadId: "t3",
    userMessage: "STALL please",
    signal: controller.signal,
  })) {
    events.push(ev);
    if (ev.type === "delta") controller.abort();
  }
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  const dones = events.filter((e) => e.type === "done");
  assert.equal(dones.length, 1);
  const done = dones[0];
  assert.ok(done.type === "done");
  assert.equal(done.stopped, true);
  assert.equal(done.fullText, "partial");
});
