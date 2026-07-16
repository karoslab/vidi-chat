/**
 * Browser Rails — CLI wiring seam (Phase 1).
 *
 * This is the twin of the `--mcp-config PLAYWRIGHT_MCP_CONFIG` block in
 * lib/providers/claude.ts, but GATED on the Browser Rails flag instead of on
 * auto mode. It returns the extra CLI arguments (mcp-config path + the
 * allowedTools additions) ONLY when the flag is on; OFF → an empty array, so the
 * spawned CLI never even learns the browser tools exist.
 *
 * Phase 1 scope, stated honestly: the config GENERATION and gating here are real
 * and tested. The stdio MCP server PROCESS those args would point at is the
 * Phase 2 build (it needs the @modelcontextprotocol SDK, which isn't vendored
 * yet). Until then this function returns the gating decision and the tool-name
 * additions; claude.ts can adopt it when the server binary lands. Keeping the
 * seam here (rather than inline in claude.ts) is deliberate: the trust surface
 * stays in one reviewable module.
 */

import { browserRailsEnabled } from "./config.ts";
import { BROWSER_TOOL_NAMES } from "./tools.ts";

/** The MCP server name the tools are namespaced under (mcp__browser_rails__*). */
export const BROWSER_MCP_SERVER_NAME = "browser_rails";

export interface BrowserRailsCliWiring {
  /** True when the flag is on (the tools should be advertised). */
  enabled: boolean;
  /** The comma-join fragment to append to --allowedTools. Empty when OFF. */
  allowedToolsFragment: string;
  /** The bare tool names (namespaced) this session exposes. Empty when OFF. */
  toolNames: string[];
}

/**
 * Compute the CLI wiring for the current flag state. Read live so a mid-session
 * toggle is honored on the next turn's spawn, exactly like builder-mode.
 */
export function browserRailsCliWiring(): BrowserRailsCliWiring {
  if (!browserRailsEnabled()) {
    return { enabled: false, allowedToolsFragment: "", toolNames: [] };
  }
  const toolNames = BROWSER_TOOL_NAMES.map(
    (t) => `mcp__${BROWSER_MCP_SERVER_NAME}__${t}`
  );
  // The bare server name in allowedTools admits all of its tools, matching how
  // claude.ts admits ",mcp__playwright".
  return {
    enabled: true,
    allowedToolsFragment: `,mcp__${BROWSER_MCP_SERVER_NAME}`,
    toolNames,
  };
}
