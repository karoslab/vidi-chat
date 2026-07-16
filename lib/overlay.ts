import fs from "node:fs";
import { dataPath } from "./data-dir.ts";
import type { AgentPublic } from "./agents/manager";

/**
 * Crew Cam overlay data — the SANITIZED, read-only projection of the fleet for
 * an OBS browser source on the owner's build-in-public stream. Security-critical:
 * this is shown on a public stream, so it must NEVER leak agent feed text
 * (which can contain prompts, file paths, secrets). buildOverlay whitelists
 * fields explicitly — it never spreads an agent object — so a new field on the
 * agent can't accidentally appear on stream. tests/overlay.test.ts asserts this.
 */

export interface OverlayAgent {
  name: string;
  status: "idle" | "working" | "error";
  turns: number;
  tokensOut: number;
}

export interface OverlayData {
  day: number;
  revenueUsd: number;
  goalUsd: number;
  workingCount: number;
  agents: OverlayAgent[];
}

// Resolved at CALL time (shared dataDir(): VIDI_DATA_DIR override, else
// <cwd>/data) — unset resolves byte-identically to <cwd>/data/overlay-config.json.
const configFile = () => dataPath("overlay-config.json");
const DAY_MS = 24 * 60 * 60 * 1000;

interface OverlayConfig {
  day?: number;
  startDateMs?: number; // streak start; day computed from it if `day` absent
  revenueUsd?: number;
  goalUsd?: number;
}

export function readOverlayConfig(): OverlayConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

/** Pure, whitelist-only projection. `now` is injectable for tests. */
export function buildOverlay(
  agents: AgentPublic[],
  config: OverlayConfig,
  now = Date.now()
): OverlayData {
  const day =
    typeof config.day === "number"
      ? config.day
      : typeof config.startDateMs === "number"
        ? Math.max(1, Math.floor((now - config.startDateMs) / DAY_MS) + 1)
        : 1;

  // Explicit field-by-field copy — NEVER spread the agent (feed/model/ids/etc.
  // must not reach the stream).
  const overlayAgents: OverlayAgent[] = agents.map((a) => ({
    name: a.name,
    status: a.status,
    turns: a.turns,
    tokensOut: a.tokens.output,
  }));

  return {
    day,
    revenueUsd: typeof config.revenueUsd === "number" ? config.revenueUsd : 0,
    goalUsd: typeof config.goalUsd === "number" ? config.goalUsd : 10000,
    workingCount: overlayAgents.filter((a) => a.status === "working").length,
    agents: overlayAgents,
  };
}
