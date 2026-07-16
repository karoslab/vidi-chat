import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderStreamEvent } from "../lib/providers/types.ts";

/**
 * Codex provider (lib/providers/codex.ts). Exercised against a fake `codex` CLI
 * via CODEX_BIN — never the real OpenAI CLI. The fake emits the real `codex exec
 * --json` JSONL shape (thread.started / item.completed / turn.completed) and
 * records its argv so the new model (-m <slug>) and reasoning-effort
 * (-c model_reasoning_effort=<level>) forwarding can be asserted (R3/R4).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-codex-"));
process.chdir(tmp);
process.env.VIDI_WORKSPACE_ROOT = tmp;

const ARGV_LOG = path.join(tmp, "codex-argv.json");
const FAKE_CLI = path.join(tmp, "fake-codex.mjs");
process.env.CODEX_BIN = FAKE_CLI;

fs.writeFileSync(
  FAKE_CLI,
  `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify(argv));
const out = (o) => console.log(JSON.stringify(o));
const ri = argv.indexOf("resume");
const threadId = ri >= 0 ? argv[ri + 1] : "codex-thread-1";
out({ type: "thread.started", thread_id: threadId });
out({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "Hi there" } });
out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } });
`,
  { mode: 0o755 }
);

const { codexProvider, codexReasoningEffort } = await import("../lib/providers/codex.ts");

async function collect(
  args: Parameters<typeof codexProvider.sendMessage>[0]
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const ev of codexProvider.sendMessage(args)) events.push(ev);
  return events;
}

const argv = (): string[] => JSON.parse(fs.readFileSync(ARGV_LOG, "utf8"));
const flagVal = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

test("models: the pseudo-model id stays 'default' but is relabelled Auto (Vidi routes) (FIX 4)", () => {
  const ids = codexProvider.models.map((m) => m.id);
  assert.deepEqual(ids, ["default", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
  // "default" is still the default pseudo-model (config-driven) — id UNCHANGED.
  assert.equal(codexProvider.models.find((m) => m.default)?.id, "default");
  // FIX 4: only the label changed, from "Default (config)".
  assert.equal(
    codexProvider.models.find((m) => m.id === "default")?.label,
    "Auto (Vidi routes)"
  );
  // Requested "GPT-5.6 Tera" → the CLI-correct slug is gpt-5.6-terra.
  assert.ok(codexProvider.models.some((m) => m.id === "gpt-5.6-terra"));
});

test("codexReasoningEffort: full 6-level ladder clamps per-model ceiling (FIX 6)", () => {
  // Codex accepts all six literally; each model clamps DOWN to its ceiling.
  //   gpt-5.5 → xhigh | luna → max | sol/terra → ultra
  const table: Record<string, Record<string, string>> = {
    "gpt-5.5": {
      low: "low", medium: "medium", high: "high",
      xhigh: "xhigh", max: "xhigh", ultra: "xhigh",
    },
    "gpt-5.6-luna": {
      low: "low", medium: "medium", high: "high",
      xhigh: "xhigh", max: "max", ultra: "max",
    },
    "gpt-5.6-sol": {
      low: "low", medium: "medium", high: "high",
      xhigh: "xhigh", max: "max", ultra: "ultra",
    },
    "gpt-5.6-terra": {
      low: "low", medium: "medium", high: "high",
      xhigh: "xhigh", max: "max", ultra: "ultra",
    },
  };
  for (const [model, levels] of Object.entries(table)) {
    for (const [input, expected] of Object.entries(levels)) {
      assert.equal(
        codexReasoningEffort(model, input),
        expected,
        `${model} @ ${input} → ${expected}`
      );
    }
  }
  // absent effort → no override (config.toml default).
  assert.equal(codexReasoningEffort("gpt-5.6-sol", undefined), undefined);
});

test("a real slug forwards -m and -c model_reasoning_effort (R3)", async () => {
  await collect({ threadId: "t1", userMessage: "hi", model: "gpt-5.6-sol", effort: "high" });
  const a = argv();
  assert.equal(flagVal(a, "-m"), "gpt-5.6-sol");
  assert.equal(flagVal(a, "-c"), "model_reasoning_effort=high");
});

test("ultra effort forwards the model's clamped level (luna → max)", async () => {
  await collect({ threadId: "t2", userMessage: "hi", model: "gpt-5.6-luna", effort: "ultra" });
  const a = argv();
  assert.equal(flagVal(a, "-m"), "gpt-5.6-luna");
  assert.equal(flagVal(a, "-c"), "model_reasoning_effort=max");
});

test('"default" model forwards NO -m and NO effort (config.toml still rules)', async () => {
  await collect({ threadId: "t3", userMessage: "hi", model: "default", effort: "ultra" });
  const a = argv();
  assert.equal(a.includes("-m"), false, "default must not pin a model");
  assert.equal(a.includes("-c"), false, "default must not override reasoning effort");
  // Sanity: it still runs read-only exec.
  assert.ok(a.includes("exec"));
  assert.equal(flagVal(a, "-s"), "read-only");
});

test("a real slug with no effort forwards -m but leaves effort to config", async () => {
  await collect({ threadId: "t4", userMessage: "hi", model: "gpt-5.5" });
  const a = argv();
  assert.equal(flagVal(a, "-m"), "gpt-5.5");
  assert.equal(a.includes("-c"), false);
});

test("streams the agent_message as a delta then a done with the thread id", async () => {
  const events = await collect({ threadId: "t5", userMessage: "hi", model: "gpt-5.6-sol", effort: "medium" });
  const deltas = events.filter((e) => e.type === "delta");
  assert.equal(deltas.map((d) => (d.type === "delta" ? d.text : "")).join(""), "Hi there");
  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.providerSessionId, "codex-thread-1");
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("the owner's standing rules land in the outgoing system block (user-rules.ts)", async () => {
  // Point os.homedir() at a fixture holding ~/.claude/CLAUDE.md — the global
  // rules source. A fresh (non-resuming) turn prepends the delimited block to
  // the prompt's <system>…</system> for EVERY provider (same wiring in
  // claude.ts + grok.ts).
  const { USER_RULES_HEADING, _resetUserRulesCache } = await import(
    "../lib/user-rules.ts"
  );
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vidi-codex-home-"));
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(fakeHome, ".claude", "CLAUDE.md"),
    "RULE: lead with the counterargument."
  );
  process.env.HOME = fakeHome;
  _resetUserRulesCache();
  await collect({ threadId: "rules1", userMessage: "hi" });
  const prompt = argv().at(-1) as string;
  assert.ok(prompt.includes(USER_RULES_HEADING), "heading must be in the prompt");
  assert.ok(prompt.includes("lead with the counterargument"), "rules body must be present");
});
