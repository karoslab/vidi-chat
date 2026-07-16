import fs from "node:fs";
import { getThread, listThreads } from "@/lib/store";
import { workspacePath } from "@/lib/workspace";
import { getUserConfig } from "@/lib/user-config";
import { requireReadAuth } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * Cross-brain short-term memory for the vision path.
 *
 * GET → { "recent": string, "modelDigest": string }
 *
 * `recent` is the last few turns across BOTH the voice thread (agent) and the
 * vision thread (screenshot Q&A) from the past two hours, compacted to ~1KB.
 * The Mac app fetches this (500ms budget, fail-open) when building the vision
 * system prompt, so "like I said a minute ago" works across brains in both
 * directions.
 *
 * `modelDigest` is the head of the nightly-maintained user model (Workstream
 * B4) — empty string until that file exists.
 *
 * Token gated (requireReadAuth — Tier-2): recent voice/vision transcripts are
 * the most sensitive read here, so the raw-TCP tailnet door is closed with a
 * positive credential, not a forgeable loopback-Host check. The browser sends
 * the injected session token; ops readers send the control token. NOTE: the
 * Swift app (VisionHistoryStore.fetchCrossBrainContext) currently sends NO token
 * and now gets a 401 — its fetch fails OPEN (returns nil, the vision turn
 * proceeds with empty cross-brain context), so nothing breaks; it must be
 * rebuilt to send x-vidi-session-token to restore that context. See PR body.
 */

const RECENT_THREAD_TITLES = ["voice", "vision"];
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_RECENT_TURNS = 12;
const MAX_TURN_CHARS = 160;
const USER_MODEL_PATH = workspacePath(
  getUserConfig().brainDirName,
  "wiki",
  getUserConfig().userModelFileName
);
const MAX_MODEL_DIGEST_CHARS = 600;

export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const cutoffMs = Date.now() - RECENT_WINDOW_MS;
  const recentTurns: { ts: number; line: string }[] = [];

  try {
    for (const meta of listThreads()) {
      if (meta.provider !== "claude") continue;
      if (!RECENT_THREAD_TITLES.includes(meta.title)) continue;
      // Only the tail can be recent — threads are append-only.
      const thread = getThread(meta.id);
      if (!thread) continue;
      for (const message of thread.messages.slice(-MAX_RECENT_TURNS * 2)) {
        if (message.ts < cutoffMs) continue;
        const clock = new Date(message.ts).toTimeString().slice(0, 5);
        const speaker = message.role === "user" ? getUserConfig().displayName : "Vidi";
        const oneLine = message.text.replace(/\s+/g, " ").trim();
        const clipped =
          oneLine.length > MAX_TURN_CHARS
            ? oneLine.slice(0, MAX_TURN_CHARS - 1) + "…"
            : oneLine;
        recentTurns.push({
          ts: message.ts,
          line: `${clock} ${speaker} (${meta.title}): ${clipped}`,
        });
      }
    }
  } catch {
    /* fail-open: empty context beats a broken vision turn */
  }

  const recent = recentTurns
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_RECENT_TURNS)
    .map((turn) => turn.line)
    .join("\n");

  let modelDigest = "";
  try {
    modelDigest = fs
      .readFileSync(USER_MODEL_PATH, "utf8")
      .trim()
      .slice(0, MAX_MODEL_DIGEST_CHARS);
  } catch {
    /* user model not seeded yet */
  }

  return Response.json({ recent, modelDigest });
}
