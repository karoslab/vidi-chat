import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * Grok provider (lib/providers/grok.ts). Exercised against a fake `grok` CLI via
 * GROK_BIN — never the real xAI CLI. The fake emits the real streaming-json
 * shape ({type:"thought"|"text"|"end"|"error"}) so the parser is tested against
 * the documented (and machine-verified) output, and records its argv to a file
 * so the read-only / model / effort / resume flags can be asserted.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-grok-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const ARGV_LOG = path.join(tmp, "grok-argv.json");
const FAKE_CLI = path.join(tmp, "fake-grok.mjs");
process.env.GROK_BIN = FAKE_CLI;

// The fake CLI: log argv, then branch on flags to emit the right stream.
//  - a `-r <id>` for the stale session id triggers the error+exit(1) path.
//  - otherwise emit a reasoning thought, two text chunks, and an end event that
//    echoes back the resumed session id (or a fresh one).
fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(argv));
const out = (o) => console.log(JSON.stringify(o));
const ri = argv.indexOf("-r");
const resumeId = ri >= 0 ? argv[ri + 1] : null;
const pi = argv.indexOf("-p");
const prompt = pi >= 0 ? argv[pi + 1] : "";
if (resumeId === "stale-session-id") {
  out({ type: "error", message: "Couldn't create session: Session does not exist" });
  process.exit(1);
}
if (prompt.includes("STALL")) {
  out({ type: "text", data: "partial" });
  setInterval(() => {}, 1000); // hang until SIGKILLed by the abort
} else {
  out({ type: "thought", data: "thinking about it" });
  out({ type: "text", data: "Hello" });
  out({ type: "text", data: " world" });
  out({ type: "end", stopReason: "EndTurn", sessionId: resumeId || "fresh-session-1", requestId: "req-1" });
}
`,
  { mode: 0o755 }
);

const { grokProvider, resolveGrokModel, grokEffort } = await import(
  "../lib/providers/grok.ts"
);

async function collect(
  args: Parameters<typeof grokProvider.sendMessage>[0]
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of grokProvider.sendMessage(args)) events.push(ev);
  return events;
}

test("id/label/models — two ids (Build default, Chat), both on the audited grok-4.5 (FIX 3)", async () => {
  assert.equal(grokProvider.id, "grok");
  assert.equal(grokProvider.label, "Grok (xAI)");
  const ids = grokProvider.models.map((m) => m.id);
  assert.deepEqual(ids, ["grok-4.5-build", "grok-4.5-chat"]);
  // Build is the default so existing threads are unchanged.
  assert.equal(grokProvider.models.find((m) => m.default)?.id, "grok-4.5-build");
  // Composer/coding models need a different grok agent ('cursor') outside the
  // confinement audit and break resumed sessions — must not be offered.
  assert.ok(!ids.includes("grok-composer-2.5-fast"));
  assert.equal((await grokProvider.available()).ok, true);
});

test("resolveGrokModel: only grok-4.5-chat is Chat; everything else resolves to Build (FIX 3)", () => {
  assert.deepEqual(resolveGrokModel("grok-4.5-chat"), {
    wireModel: "grok-4.5",
    agentMode: "chat",
    planMode: true,
  });
  for (const id of [
    "grok-4.5-build",
    "grok-4.5", // legacy stored id
    "default",
    "auto",
    null,
    undefined,
    "grok-composer-2.5-fast", // stale incompatible id
  ]) {
    const r = resolveGrokModel(id as string | null | undefined);
    assert.equal(r.wireModel, "grok-4.5", `wire model for ${id}`);
    assert.equal(r.agentMode, "build", `agent mode for ${id}`);
    assert.equal(r.planMode, false, `plan mode for ${id}`);
  }
});

test("grokEffort clamps the ladder to grok's max ceiling (FIX 6)", () => {
  const table: Record<string, string | undefined> = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    ultra: "max", // clamp: grok tops out at max
  };
  for (const [input, expected] of Object.entries(table)) {
    assert.equal(grokEffort(input), expected, `${input} → ${expected}`);
  }
  assert.equal(grokEffort(undefined), undefined);
});

test("Chat posture adds --permission-mode plan; Build does not — sandbox identical (FIX 3)", async () => {
  const flagOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  await collect({ threadId: "tc-chat", userMessage: "hi", model: "grok-4.5-chat" });
  let argv: string[] = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  assert.equal(flagOf(argv, "--permission-mode"), "plan");
  // Same confinement as Build.
  assert.equal(flagOf(argv, "--sandbox"), "strict");
  assert.equal(flagOf(argv, "--tools"), "todo_write");
  assert.ok(argv.includes("--no-subagents"));

  await collect({ threadId: "tc-build", userMessage: "hi", model: "grok-4.5-build" });
  argv = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  assert.ok(!argv.includes("--permission-mode"), "Build passes no permission-mode");
  // Identical sandbox — Chat never loosens it.
  assert.equal(flagOf(argv, "--sandbox"), "strict");
  assert.equal(flagOf(argv, "--tools"), "todo_write");
});

test("streaming-json parses into deltas + one reasoning + a done with the session id", async () => {
  const events = await collect({
    threadId: "t1",
    userMessage: "hi",
    model: "grok-4.5",
    mode: "plan",
    effort: "high",
  });

  const deltas = events.filter((e) => e.type === "delta");
  assert.deepEqual(
    deltas.map((d) => (d.type === "delta" ? d.text : "")),
    ["Hello", " world"]
  );

  // Reasoning is a single honest boolean signal, never the thought text.
  const reasoning = events.filter((e) => e.type === "reasoning");
  assert.equal(reasoning.length, 1);
  assert.ok(!JSON.stringify(events).includes("thinking about it"));

  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.fullText, "Hello world");
  assert.equal(done.providerSessionId, "fresh-session-1");
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("confinement argv: strict sandbox + jailed cwd + tool allowlist/denylist, never --yolo", async () => {
  await collect({ threadId: "t2", userMessage: "hi", model: "grok-4.5", mode: "auto" });
  const argv: string[] = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));

  const flagArg = (flag: string) => argv[argv.indexOf(flag) + 1];
  // WRITE + READ boundary: strict (a read whitelist, unlike read-only) with cwd
  // pointed at an empty jail OUTSIDE the workspace so neither the workspace nor
  // $HOME is readable or writable by grok.
  assert.equal(flagArg("--sandbox"), "strict");
  const cwd = flagArg("--cwd");
  assert.ok(cwd.includes("vidi-grok-sandbox"), `cwd should be the jail, got ${cwd}`);
  assert.ok(!cwd.includes(tmp) || cwd.startsWith(os.tmpdir()), "cwd must not be the workspace root");
  assert.notEqual(cwd, tmp); // never the workspace root itself

  // READ + EGRESS: the allowlist is the primary control. Grok is a read-only
  // chat brain whose persona is injected in-process, so it gets NO fs read tools
  // — just one harmless non-fs/non-net tool (todo_write). An empty "--tools ""
  // is NOT safe: grok reads it as "default toolset" and re-enables read_file
  // (verified live — it read ~/.grok/auth.json and printed the token).
  assert.equal(flagArg("--tools"), "todo_write");
  // read_file / list_dir must be ABSENT so grok cannot read the kernel-readable
  // ~/.grok credentials or ~/Library/Keychains that strict does NOT deny.
  const allowed = flagArg("--tools").split(",");
  assert.ok(!allowed.includes("read_file"), "read_file must not be in --tools");
  assert.ok(!allowed.includes("list_dir"), "list_dir must not be in --tools");

  // Belt: denylist names every egress/escalation tool (both shell names + the
  // background-task monitor path + the use_tool meta-tool).
  const denied = flagArg("--disallowed-tools").split(",");
  for (const t of [
    "run_terminal_command",
    "run_terminal_cmd",
    "web_fetch",
    "web_search",
    "x_user_search",
    "x_semantic_search",
    "x_keyword_search",
    "x_thread_fetch",
    "image_gen",
    "spawn_subagent",
    "use_tool",
    "monitor",
  ]) {
    assert.ok(denied.includes(t), `--disallowed-tools missing ${t}`);
  }
  assert.ok(argv.includes("--disable-web-search"));
  assert.ok(argv.includes("--no-subagents"));

  assert.equal(flagArg("--output-format"), "streaming-json");
  // mode:"auto" must NOT unlock write/act — grok ignores mode entirely.
  assert.ok(!argv.includes("--yolo"));
  assert.ok(!argv.includes("--always-approve"));
  assert.ok(!argv.includes("--permission-mode"));
  // The old, audit-failed confinement must be gone.
  assert.ok(!argv.includes("read-only"));
});

test("model + effort map to -m / --reasoning-effort; default/auto fall back to grok-4.5, ultra->max", async () => {
  await collect({ threadId: "t3", userMessage: "hi", model: "default", effort: "ultra" });
  let argv: string[] = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  assert.equal(argv[argv.indexOf("-m") + 1], "grok-4.5");
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "max");

  // A stale/unsupported model id (e.g. persisted on an older thread) coerces to
  // grok-4.5 rather than passing through — prevents an incompatible-agent switch.
  await collect({ threadId: "t3b", userMessage: "hi", model: "grok-composer-2.5-fast" });
  argv = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  assert.equal(argv[argv.indexOf("-m") + 1], "grok-4.5");
  assert.ok(!argv.includes("--reasoning-effort")); // no effort supplied -> flag omitted
});

test("resume: prior session id is passed as -r and continuity id is returned", async () => {
  const events = await collect({
    threadId: "t4",
    userMessage: "and then?",
    priorProviderSessionId: "sess-abc",
    model: "grok-4.5",
  });
  const argv: string[] = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  assert.equal(argv[argv.indexOf("-r") + 1], "sess-abc");
  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.providerSessionId, "sess-abc");
});

test("a stale resume id surfaces an error flagged resetProviderSession", async () => {
  const events = await collect({
    threadId: "t5",
    userMessage: "hi",
    priorProviderSessionId: "stale-session-id",
    model: "grok-4.5",
  });
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.resetProviderSession, true);
  // Server-side error keeps the CLI detail (the UI classifier scrubs it later).
  assert.ok(err.message.includes("Session does not exist"));
});

test("aborting mid-stream persists the partial text as a done flagged stopped — no error", async () => {
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  for await (const ev of grokProvider.sendMessage({
    threadId: "t6",
    userMessage: "STALL please",
    model: "grok-4.5",
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

test("the owner's standing rules land in the injected <system> block (user-rules.ts)", async () => {
  // Same assertion as codex/claude: a fresh grok turn prepends the delimited
  // rules block (from ~/.claude/CLAUDE.md via os.homedir()) into <system>.
  const { USER_RULES_HEADING, _resetUserRulesCache } = await import(
    "../lib/user-rules.ts"
  );
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-grok-home-"));
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".claude", "CLAUDE.md"),
    "RULE: give confidence levels."
  );
  process.env.HOME = fakeHome;
  _resetUserRulesCache();
  await collect({ threadId: "rules-grok", userMessage: "hi", model: "grok-4.5" });
  const argv: string[] = JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
  const prompt = argv[argv.indexOf("-p") + 1];
  assert.ok(prompt.includes(USER_RULES_HEADING), "heading must be in <system>");
  assert.ok(prompt.includes("give confidence levels"), "rules body must be present");
});
