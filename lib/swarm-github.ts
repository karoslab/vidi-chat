import { execFile } from "node:child_process";

/**
 * Swarm ↔ GitHub reconciliation (FIX 2).
 *
 * The swarm orchestrator writes each worker's `status` and never updates it
 * after `APPROVE PR n` merges the PR (the inbox poller merges; the swarm never
 * learns). So workers sit at "pending-approval" / "review-error" in the state
 * files long after their PRs actually merged — and the sidebar's attention
 * filter (SWARM_ATTENTION_STATUSES) keeps showing them.
 *
 * Fix: before the attention filter, validate every worker whose status needs
 * eyes against real GitHub state (`gh pr list --repo karoslab/<repo> ...`) and
 * reclassify MERGED/CLOSED PRs so the attention filter drops them. Fail OPEN: if
 * gh can't answer, keep the orchestrator's status — never crash the route.
 */

/** Statuses that STILL need the owner and so must be validated against GitHub. */
export const SWARM_VALIDATE_STATUSES = new Set(["pending-approval", "review-error"]);

/**
 * Reclassify one worker's status against a known PR-state map. Pure — unit
 * tested with a fake map.
 *   - Only touches workers whose status is in SWARM_VALIDATE_STATUSES.
 *   - Workers with pr == null keep their status (nothing to check).
 *   - A MERGED PR → "merged"; a CLOSED (un-merged) PR → "closed".
 *   - OPEN or unknown (gh didn't return it) → keep the orchestrator's status
 *     (fail open).
 * @param prStates keyed "<repo>#<pr>" → gh state string ("MERGED"|"CLOSED"|"OPEN").
 */
export function reclassifyWorkerStatus(
  repo: string,
  worker: { status: string; pr: number | null | undefined },
  prStates: Map<string, string>
): string {
  if (!SWARM_VALIDATE_STATUSES.has(worker.status)) return worker.status;
  if (worker.pr == null) return worker.status;
  const state = prStates.get(`${repo}#${worker.pr}`);
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return worker.status;
}

/** In-memory cache of a repo's PR states, keyed by repo basename. ~60s TTL so a
 *  fast canvas poll doesn't spawn gh constantly. Stashed on globalThis so
 *  next-dev HMR doesn't fork it. */
interface RepoCacheEntry {
  at: number;
  states: Map<string, string>;
}
const CACHE_TTL_MS = 60_000;
const ghCache: Map<string, RepoCacheEntry> = ((
  globalThis as Record<string, any>
).__vidiSwarmGhCache ??= new Map());

function ghBin(): string {
  return process.env.GH_BIN || "gh";
}

/** One batched `gh pr list` per repo per cache window → number→state map. */
function ghPrList(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ghBin(),
      [
        "pr",
        "list",
        "--repo",
        `karoslab/${repo}`,
        "--state",
        "all",
        "--json",
        "number,state",
        "--limit",
        "100",
      ],
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Fetch (cached) the PR-state map for one repo: "<repo>#<pr>" → state. Fails
 * OPEN — on any gh error returns the last good cache if present, else an empty
 * map (so the caller keeps every orchestrator status).
 */
export async function fetchRepoPrStates(repo: string): Promise<Map<string, string>> {
  const cached = ghCache.get(repo);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.states;
  try {
    const out = await ghPrList(repo);
    const states = new Map<string, string>();
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      for (const pr of parsed) {
        if (typeof pr?.number === "number" && typeof pr?.state === "string") {
          states.set(`${repo}#${pr.number}`, pr.state);
        }
      }
    }
    ghCache.set(repo, { at: Date.now(), states });
    return states;
  } catch {
    return cached?.states ?? new Map();
  }
}
