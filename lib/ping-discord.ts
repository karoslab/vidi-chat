import { spawn } from "node:child_process";
import { workspacePath } from "./workspace.ts";
import { isOwner } from "./user-config.ts";

/**
 * Non-fatal, fire-and-forget Discord ping used by the voice path for
 * operational events (spawn, loop, kill-switch) — never for responses.
 * notify.py reads its own .env. Split into its own module so both voice-turn.ts
 * and voice-fleet.ts can use it without a circular import between them.
 */

const NOTIFY_SCRIPT = workspacePath("ops", "notify.py");

export function pingDiscord(text: string): void {
  // Phase 4a — H8: a NON-owner install makes ZERO external network calls, and a
  // Discord ping IS off-machine egress. No-op for a non-owner (fail-open — this
  // is best-effort telemetry, never a turn dependency). Owner unchanged.
  if (!isOwner()) return;
  try {
    const child = spawn("python3", [NOTIFY_SCRIPT, "--channel", "dev", "--text", text], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* never let the ping break the endpoint */
  }
}
