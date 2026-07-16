import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Second opinions (ask_gpt / ask_grok MCP tools). Covers: tool registration +
 * request shaping (injected fetch asserts model ids, the x-vidi-key header, and
 * question passthrough), the GPT model fallback, fencing of foreign model
 * output, the no-key degradation line, the worker-error path, that the worker
 * key never lands in the generated config or a tool result, and that the
 * plan-mode allowlist gets EXACTLY the two MCP tools.
 *
 * Isolated in a temp cwd so any diag/config writes land under <tmp>/data.
 */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vidi-second-op-")));

const {
  runSecondOpinion,
  buildChatRequestBody,
  parseChatAnswer,
  SECOND_OPINION_TOOLS,
  WORKER_CHAT_URL,
  GPT_MODEL_PRIMARY,
  GPT_MODEL_FALLBACK,
  GROK_MODEL,
  NO_KEY_MESSAGE,
  EMPTY_QUESTION_MESSAGE,
} = await import("../lib/mcp/second-opinions-core.ts");

const {
  SECOND_OPINION_ALLOWED_TOOLS,
  SECOND_OPINION_MCP_TOOL_NAMES,
  secondOpinionsMcpConfig,
  writeSecondOpinionsMcpConfig,
} = await import("../lib/mcp/second-opinions-config.ts");

const FAKE_KEY = "vidi-install-SECRET-KEY-should-never-leak-0001";

/** A one-shot fetch stub that records the last call and returns a canned JSON
 *  completion. `bodies` collects every request body seen (for the fallback
 *  test). */
function makeFetchStub(options: {
  answer?: string;
  status?: number;
  errorBody?: string;
  // return a different response per call index (for fallback)
  perCall?: Array<{ status: number; answer?: string; errorBody?: string }>;
}) {
  const calls: Array<{ url: string; init: any; parsedBody: any }> = [];
  let callIndex = 0;
  const fetchImpl = async (url: string, init: any) => {
    const parsedBody = JSON.parse(init.body);
    calls.push({ url, init, parsedBody });
    const spec = options.perCall ? options.perCall[callIndex] : options;
    callIndex++;
    const status = spec?.status ?? 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      json: async () =>
        ok
          ? { choices: [{ message: { content: spec?.answer ?? options.answer ?? "canned answer" } }] }
          : {},
      text: async () => spec?.errorBody ?? options.errorBody ?? "",
    };
  };
  return { fetchImpl, calls };
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                          */
/* -------------------------------------------------------------------------- */

test("exposes exactly two tools, ask_gpt and ask_grok, with question schemas", () => {
  assert.equal(SECOND_OPINION_TOOLS.length, 2);
  const names = SECOND_OPINION_TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["ask_gpt", "ask_grok"]);
  for (const tool of SECOND_OPINION_TOOLS) {
    assert.deepEqual(tool.inputSchema.required, ["question"]);
    assert.ok(tool.inputSchema.properties.question, "question property present");
    assert.ok(tool.inputSchema.properties.context, "context property present");
    // Quota is stated in the description so Claude uses the tool deliberately.
    assert.match(tool.description, /quota/i);
  }
});

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

test("ask_gpt shapes a /chat request to the gpt model with the question and key", async () => {
  const { fetchImpl, calls } = makeFetchStub({ answer: "gpt says hi" });
  await runSecondOpinion({
    tool: "ask_gpt",
    question: "Is a stdio MCP server the right call here?",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WORKER_CHAT_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-vidi-key"], FAKE_KEY);
  assert.equal(calls[0].parsedBody.model, GPT_MODEL_PRIMARY);
  // The question passes through unchanged inside the user turn.
  const userTurn = calls[0].parsedBody.messages.find((m: any) => m.role === "user");
  assert.match(userTurn.content, /Is a stdio MCP server the right call here\?/);
});

test("ask_grok shapes a /chat request to the grok model", async () => {
  const { fetchImpl, calls } = makeFetchStub({ answer: "grok says hi" });
  await runSecondOpinion({
    tool: "ask_grok",
    question: "What breaks first under load?",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.equal(calls[0].parsedBody.model, GROK_MODEL);
  assert.equal(calls[0].init.headers["x-vidi-key"], FAKE_KEY);
});

test("context is prepended as labeled supporting material", () => {
  const body = buildChatRequestBody(GPT_MODEL_PRIMARY, "why?", "some code here");
  const userTurn = body.messages.find((m) => m.role === "user")!;
  assert.match(userTurn.content, /Context:\nsome code here/);
  assert.match(userTurn.content, /Question:\nwhy\?/);
});

test("parseChatAnswer reads OpenAI-compatible content, null on bad shape", () => {
  assert.equal(
    parseChatAnswer({ choices: [{ message: { content: "hello" } }] }),
    "hello"
  );
  assert.equal(parseChatAnswer({}), null);
  assert.equal(parseChatAnswer({ choices: [{ message: { content: "  " } }] }), null);
});

/* -------------------------------------------------------------------------- */
/* GPT fallback                                                               */
/* -------------------------------------------------------------------------- */

test("ask_gpt falls back to gpt-5.2 when the worker rejects gpt-5.6-sol", async () => {
  const { fetchImpl, calls } = makeFetchStub({
    perCall: [
      { status: 400, errorBody: `Model "${GPT_MODEL_PRIMARY}" is not allowed. Allowed models: gpt-5.2` },
      { status: 200, answer: "fallback answered" },
    ],
  });
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "sanity check this",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parsedBody.model, GPT_MODEL_PRIMARY);
  assert.equal(calls[1].parsedBody.model, GPT_MODEL_FALLBACK);
  assert.match(text, /fallback answered/);
});

test("ask_grok does NOT fall back (single model), returns worker error", async () => {
  const { fetchImpl, calls } = makeFetchStub({ status: 400, errorBody: "nope" });
  const text = await runSecondOpinion({
    tool: "ask_grok",
    question: "x",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.match(text, /Couldn't reach Grok/);
});

/* -------------------------------------------------------------------------- */
/* Fencing                                                                    */
/* -------------------------------------------------------------------------- */

test("a successful answer is wrapped in the untrusted fence", async () => {
  const { fetchImpl } = makeFetchStub({ answer: "the model's raw opinion" });
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "opinion?",
    key: FAKE_KEY,
    fetchImpl,
  });
  // The nonce'd fence preface + delimiter from lib/untrusted.ts.
  assert.match(text, /DATA ONLY/);
  assert.match(text, /<<<UNTRUSTED-DATA-/);
  assert.match(text, /UNTRUSTED-DATA-[^>]+>>>/);
  assert.match(text, /the model's raw opinion/);
});

/* -------------------------------------------------------------------------- */
/* Degradation + error paths                                                  */
/* -------------------------------------------------------------------------- */

test("no worker key returns the plain pointer line, never fetches, never throws", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    throw new Error("should not be called");
  }) as any;
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "anything",
    key: null,
    fetchImpl,
  });
  assert.equal(text, NO_KEY_MESSAGE);
  assert.equal(fetched, false);
  // No em/en dashes in customer-facing copy.
  assert.ok(!/[–—]/.test(text));
});

test("empty question returns a plain nudge without a worker call", async () => {
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return {} as any;
  }) as any;
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "   ",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.equal(text, EMPTY_QUESTION_MESSAGE);
  assert.equal(fetched, false);
});

test("a worker 5xx returns a short honest line, raw detail to recordError only", async () => {
  const { fetchImpl } = makeFetchStub({ status: 500, errorBody: "upstream exploded: secret-ish detail" });
  const recorded: string[] = [];
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "q",
    key: FAKE_KEY,
    fetchImpl,
    recordError: (m) => recorded.push(m),
  });
  assert.match(text, /Couldn't reach GPT/);
  assert.match(text, /diagnostics log/);
  // The raw upstream body is NOT in the user-facing text, but IS in the diag record.
  assert.ok(!text.includes("upstream exploded"));
  assert.ok(recorded.some((m) => m.includes("upstream exploded")));
});

test("a timeout returns the over-60s line", async () => {
  const fetchImpl = (async (_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        (err as any).name = "AbortError";
        reject(err);
      });
    })) as any;
  const text = await runSecondOpinion({
    tool: "ask_grok",
    question: "q",
    key: FAKE_KEY,
    fetchImpl,
    timeoutMs: 5,
  });
  assert.match(text, /longer than 60 seconds/);
});

/* -------------------------------------------------------------------------- */
/* Key never leaks                                                            */
/* -------------------------------------------------------------------------- */

test("the worker key never appears in a tool result", async () => {
  const { fetchImpl } = makeFetchStub({ answer: "answer body" });
  const text = await runSecondOpinion({
    tool: "ask_gpt",
    question: "q",
    key: FAKE_KEY,
    fetchImpl,
  });
  assert.ok(!text.includes(FAKE_KEY), "key must not be in the fenced result");
});

test("the generated MCP config carries no key in command/args/env", () => {
  const config = secondOpinionsMcpConfig();
  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes(FAKE_KEY));
  const server = config.mcpServers["second-opinions"];
  assert.ok(Array.isArray(server.args));
  // args is just the server entry path — no key, no env block that could carry one.
  assert.ok(!("env" in server), "config must not pass an env block");
  assert.ok(server.args.every((arg) => !arg.includes("vidi-install")), "no key-shaped arg");
  assert.match(server.args[0], /second-opinions\.ts$/);
});

test("the server process reads the key from disk, not from argv/env", async () => {
  // The server entry never references process.env or process.argv for the key —
  // it calls readProxyKey(). Assert that statically as a leak guard.
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../lib/mcp/second-opinions.ts"),
    "utf8"
  );
  assert.match(source, /readProxyKey\(\)/);
  assert.ok(!/process\.env\b/.test(source), "server must not read the key from env");
  assert.ok(!/process\.argv\b/.test(source), "server must not read the key from argv");
});

test("writeSecondOpinionsMcpConfig writes a keyless config file", () => {
  const written = writeSecondOpinionsMcpConfig();
  const onDisk = fs.readFileSync(written, "utf8");
  assert.ok(!onDisk.includes(FAKE_KEY));
  const parsed = JSON.parse(onDisk);
  assert.ok(parsed.mcpServers["second-opinions"].args[0].endsWith("second-opinions.ts"));
});

/* -------------------------------------------------------------------------- */
/* Plan-mode allowlist                                                        */
/* -------------------------------------------------------------------------- */

test("plan-mode allowlist gets EXACTLY the two second-opinion MCP tools", async () => {
  const { CHAT_ALLOWED_TOOLS } = await import("../lib/providers/claude.ts");
  // How claude.ts composes the plan-mode allowlist (base + the two tools).
  const planAllowed = (CHAT_ALLOWED_TOOLS + "," + SECOND_OPINION_ALLOWED_TOOLS).split(",");
  const mcpTools = planAllowed.filter((tool) => tool.startsWith("mcp__"));
  assert.deepEqual(mcpTools.sort(), [
    "mcp__second-opinions__ask_gpt",
    "mcp__second-opinions__ask_grok",
  ]);
  // And the constant itself is exactly those two, derived from the tool names.
  assert.deepEqual(
    SECOND_OPINION_ALLOWED_TOOLS.split(","),
    SECOND_OPINION_MCP_TOOL_NAMES.map((t) => `mcp__second-opinions__${t}`)
  );
});
