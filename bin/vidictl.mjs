#!/usr/bin/env node
/**
 * vidictl — the fleet control CLI agents call back with (CNVS's cnvsctl
 * analog). Reads the control token from data/control-token (same box, same
 * user) and POSTs to the local control API. Kept dependency-free .mjs so it
 * runs with plain `node bin/vidictl.mjs` — which act mode already allowlists.
 *
 * Usage:
 *   node bin/vidictl.mjs state
 *   node bin/vidictl.mjs recall [query]
 *   node bin/vidictl.mjs remember "<fact>"
 *   node bin/vidictl.mjs tell <Name> "<task...>"
 *   node bin/vidictl.mjs spawn <claude|codex> [Name]
 *   node bin/vidictl.mjs shell "<command...>"
 *   node bin/vidictl.mjs terminals
 *   node bin/vidictl.mjs log <terminalId>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.VIDI_PORT || "4183";
const BASE = `http://127.0.0.1:${PORT}/api/control`;

function token() {
  try {
    return fs.readFileSync(path.join(REPO, "data", "control-token"), "utf8").trim();
  } catch {
    return process.env.VIDI_CONTROL_TOKEN || "";
  }
}

async function call(body) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vidi-Control-Token": token() },
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: `HTTP ${res.status}` };
  }
  return { status: res.status, json };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const [op, ...rest] = process.argv.slice(2);

const handlers = {
  async state() {
    out((await call({ op: "state" })).json);
  },
  async recall() {
    out((await call({ op: "recall", query: rest.join(" ") || undefined })).json);
  },
  async remember() {
    const text = rest.join(" ");
    if (!text) return fail("remember needs text");
    out((await call({ op: "remember", text })).json);
  },
  async tell() {
    const [name, ...task] = rest;
    if (!name || task.length === 0) return fail('tell needs: <Name> "<task>"');
    out((await call({ op: "tell", name, task: task.join(" ") })).json);
  },
  async spawn() {
    const [provider, name] = rest;
    // H10: forward this agent's own id (stamped into its CLI child env by the
    // fleet manager) so the control route can enforce spawn depth — a spawned
    // agent (depth>=1) is refused. A top-level/user vidictl call has no
    // VIDI_AGENT_ID, so spawnedBy is undefined and the spawn is depth 0.
    out(
      (await call({
        op: "spawn",
        provider: provider || "claude",
        name,
        spawnedBy: process.env.VIDI_AGENT_ID || undefined,
      })).json
    );
  },
  async close() {
    if (!rest[0]) return fail("close needs an agent name");
    out((await call({ op: "close", name: rest[0] })).json);
  },
  async shell() {
    const cmd = rest.join(" ");
    if (!cmd) return fail("shell needs a command");
    out((await call({ op: "shell", cmd })).json);
  },
  async terminals() {
    out((await call({ op: "terminals" })).json);
  },
  async log() {
    if (!rest[0]) return fail("log needs a terminal id");
    out((await call({ op: "terminalLog", id: rest[0] })).json);
  },
  // GUI actuation via the native Hands server (click/type/key/scroll/find).
  // Prefer clickElement (find UI by title) over blind coordinate clicks.
  async hands() {
    const [sub, ...a] = rest;
    let act;
    switch (sub) {
      case "health":
        return out((await call({ op: "handsHealth" })).json);
      case "snapshot":
        return out((await call({ op: "handsSnapshot" })).json);
      case "clickById":
        // id AND generation both come from `hands snapshot` — passing the
        // generation lets the native side reject a STALE id (re-snapshot).
        if (a.length < 2) return fail("clickById needs: <id> <generation>  (both from `hands snapshot`)");
        act = { action: "clickById", id: a[0], generation: Number(a[1]) };
        break;
      case "typeInById":
        if (a.length < 3) return fail("typeInById needs: <id> <generation> <text...>  (id+generation from `hands snapshot`)");
        act = { action: "typeInById", id: a[0], generation: Number(a[1]), text: a.slice(2).join(" ") };
        break;
      case "type":
        act = { action: "type", text: a.join(" ") };
        break;
      case "key":
        act = { action: "key", key: a[0], modifiers: a.slice(1) };
        break;
      case "click":
        act = { action: "click", x: Number(a[0]), y: Number(a[1]) };
        break;
      case "clickElement":
        act = { action: "clickElement", title: a.join(" ") };
        break;
      case "find":
        act = { action: "find", title: a.join(" ") };
        break;
      case "scroll":
        act = { action: "scroll", dy: Number(a[0] || 0), dx: Number(a[1] || 0) };
        break;
      case "macro": {
        const [msub, ...m] = a;
        const map = {
          record: { action: "macroRecordStart", name: m.join(" ") },
          stop: { action: "macroRecordStop" },
          list: { action: "macroList" },
          play: { action: "macroPlay", name: m.join(" ") },
          delete: { action: "macroDelete", name: m.join(" ") },
        };
        act = map[msub];
        if (!act) return fail("hands macro needs: record <name> | stop | list | play <name> | delete <name>");
        break;
      }
      default:
        return fail('hands needs: health | snapshot | clickById <id> | typeInById <id> <text> | find <title> | clickElement <title> | click <x> <y> | type <text> | key <name> [mods] | scroll <dy> [dx] | macro record|stop|list|play|delete');
    }
    out((await call({ op: "hands", act })).json);
  },
};

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exitCode = 1;
}

const handler = handlers[op];
if (!handler) {
  fail(`unknown op: ${op || "(none)"} — try: state, recall, remember, tell, spawn, close, shell, terminals, log, hands`);
} else {
  handler().catch((e) => fail(e?.message || String(e)));
}
