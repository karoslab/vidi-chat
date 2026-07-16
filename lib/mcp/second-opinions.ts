/**
 * second-opinions — a tiny stdio MCP server exposing exactly two tools,
 * ask_gpt and ask_grok, so a vidi-chat Claude session can delegate ONE bounded
 * question to GPT / Grok while Claude stays the lead model.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
 * transport). Spawned by the claude CLI from the project MCP config
 * (lib/mcp/second-opinions-config.ts). Runs as its OWN process; it reads the
 * install's worker key from disk itself (readProxyKey) and sends it only as the
 * `x-vidi-key` header — the key is never in this process's argv, never in the
 * config that launched it, and never in a tool result.
 *
 * All request shaping, model selection, the GPT fallback, and the untrusted-
 * output fencing live in ./second-opinions-core.ts (imported here, exercised by
 * the tests). This file is just the JSON-RPC plumbing.
 */

import readline from "node:readline";
import { readProxyKey } from "../proxy-secret.ts";
import { recordDiag } from "../diag-ledger.ts";
import {
  runSecondOpinion,
  SECOND_OPINION_TOOLS,
  type SecondOpinionTool,
} from "./second-opinions-core.ts";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respondResult(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(id: unknown, params: unknown): Promise<void> {
  const toolName = (params as { name?: unknown })?.name;
  const args = ((params as { arguments?: unknown })?.arguments ?? {}) as Record<
    string,
    unknown
  >;

  if (toolName !== "ask_gpt" && toolName !== "ask_grok") {
    respondError(id, -32602, `Unknown tool: ${String(toolName)}`);
    return;
  }

  const text = await runSecondOpinion({
    tool: toolName as SecondOpinionTool,
    question: typeof args.question === "string" ? args.question : "",
    context: typeof args.context === "string" ? args.context : undefined,
    // The server reads the key itself — it is never handed in via argv/env.
    key: readProxyKey(),
    fetchImpl: fetch as unknown as Parameters<typeof runSecondOpinion>[0]["fetchImpl"],
    recordError: (rawMessage) => recordDiag("route-error", rawMessage),
  });

  // A tool result is one text block. runSecondOpinion already fenced any
  // foreign model output and reduced every failure to a plain line.
  respondResult(id, { content: [{ type: "text", text }] });
}

async function handleMessage(request: {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}): Promise<void> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      respondResult(id, {
        protocolVersion:
          (params as { protocolVersion?: string })?.protocolVersion ??
          SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "second-opinions", version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      // Notifications carry no id and expect no response.
      return;
    case "tools/list":
      respondResult(id, { tools: SECOND_OPINION_TOOLS });
      return;
    case "tools/call":
      await handleToolCall(id, params);
      return;
    case "ping":
      respondResult(id, {});
      return;
    default:
      // Only answer requests (with an id); ignore stray notifications.
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${String(method)}`);
      }
      return;
  }
}

const readInterface = readline.createInterface({ input: process.stdin });
readInterface.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: { id?: unknown; method?: unknown; params?: unknown };
  try {
    request = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON noise
  }
  if (typeof request.method !== "string") return; // a response, not a request
  void handleMessage(request).catch((error) => {
    // Never let a handler rejection take down the server; surface a benign
    // tool-side failure and log the raw detail to diagnostics only.
    recordDiag("route-error", `second-opinion handler crash: ${String(error)}`);
    if (request.id !== undefined) {
      respondResult(request.id, {
        content: [{ type: "text", text: "The second-opinion tool failed unexpectedly." }],
        isError: true,
      });
    }
  });
});
