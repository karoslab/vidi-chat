/**
 * Wiring for the second-opinions stdio MCP server.
 *
 * The server is generated as a project MCP config at session start and passed to
 * the claude CLI via `--mcp-config` (alongside `--strict-mcp-config`, so ONLY
 * our configs load). It is wired in BOTH plan and act modes because the two
 * tools are read-only consultations — see lib/providers/claude.ts.
 *
 * The generated config carries NO credential: it only names the node binary and
 * the server entry file. The server process reads the worker key from disk
 * itself (readProxyKey), so the key never appears in the config's args or env.
 */

import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../data-dir.ts";

/** The MCP server name. Tool call names are `mcp__<server>__<tool>`. */
export const SECOND_OPINIONS_MCP_SERVER_NAME = "second-opinions";

/** The exactly-two tools this server exposes. */
export const SECOND_OPINION_MCP_TOOL_NAMES = ["ask_gpt", "ask_grok"] as const;

/**
 * The allowlist entries to add to `--allowedTools` in both modes: the two MCP
 * tools, fully namespaced, and ONLY these two. Exported so the plan-mode
 * allowlist is assertable without a spawn.
 */
export const SECOND_OPINION_ALLOWED_TOOLS = SECOND_OPINION_MCP_TOOL_NAMES.map(
  (toolName) => `mcp__${SECOND_OPINIONS_MCP_SERVER_NAME}__${toolName}`
).join(",");

/** Absolute path to the MCP server entry, resolved from THIS module so it is
 *  correct regardless of the CLI child's cwd (WORKSPACE_ROOT, not this repo). */
export function secondOpinionsServerEntryPath(): string {
  return path.resolve(import.meta.dirname, "second-opinions.ts");
}

/** The MCP config object. `command` is the exact node running this app (which
 *  strips .ts types), and `args` is just the server entry — no key material. */
export function secondOpinionsMcpConfig(): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  return {
    mcpServers: {
      [SECOND_OPINIONS_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [secondOpinionsServerEntryPath()],
      },
    },
  };
}

/**
 * Write the config to the data dir and return its absolute path. Best-effort at
 * the call site: a write failure just means the tools are skipped for that turn
 * (never a broken spawn).
 */
export function writeSecondOpinionsMcpConfig(): string {
  const target = dataPath("mcp-second-opinions.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(secondOpinionsMcpConfig(), null, 2));
  return target;
}
