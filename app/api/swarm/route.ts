import fs from "node:fs";
import path from "node:path";
import { workspacePath } from "@/lib/workspace";
import { requireReadAuth } from "@/lib/origin";
import {
  SWARM_VALIDATE_STATUSES,
  fetchRepoPrStates,
  reclassifyWorkerStatus,
} from "@/lib/swarm-github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

/**
 * GET → swarm pipeline state for the Fleet canvas.
 *
 * The Fleet canvas is an owner-only observability surface. It reads the state
 * files produced by a separate swarm orchestrator (an external ops tool,
 * not shipped here) under `<workspace-root>/ops/swarm/state`, one JSON per repo,
 * plus the tail of each worker's live activity log, so the canvas can show the
 * workers actually working — tool call by tool call. Read-only observability:
 * this route never mutates swarm state, and it no-ops (returns an empty Fleet)
 * when that state directory is absent — e.g. on any install without the
 * orchestrator.
 */

const SWARM_STATE_DIR = workspacePath("ops", "swarm", "state");

interface SwarmWorkerView {
  name: string | null;
  branch: string;
  task: string;
  status: string;
  pr: number | null;
  rounds: number;
  error?: string;
  /** Last few lines of the worker's live activity log (newest last). */
  activity: string[];
}

function tailLines(file: string | undefined, n: number): string[] {
  if (!file) return [];
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.trimEnd().split("\n").slice(-n);
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const unauthorized = requireReadAuth(req);
  if (unauthorized) return unauthorized;
  const swarms: { repo: string; updatedAt: number; workers: SwarmWorkerView[] }[] = [];
  // First pass: parse every state file into a raw entry (basename = the GitHub
  // repo under karoslab/). Collect which repos have a worker whose status still
  // needs eyes so we only hit gh for those.
  const raw: { repo: string; updatedAt: number; stale: boolean; workers: any[] }[] = [];
  const reposToValidate = new Set<string>();
  try {
    for (const f of fs.readdirSync(SWARM_STATE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(SWARM_STATE_DIR, f);
      let state: any;
      try {
        state = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue; // torn write mid-save — next poll gets it
      }
      if (!Array.isArray(state.workers) || state.workers.length === 0) continue;
      const updatedAt = Math.floor(fs.statSync(full).mtimeMs);
      // A live orchestrator saves state on every transition; "working" with a
      // state file untouched for 10+ minutes means the run died (killed
      // service, reboot) — surface that instead of lying.
      const stale = Date.now() - updatedAt > 10 * 60 * 1000;
      const repo = path.basename(f, ".json");
      raw.push({ repo, updatedAt, stale, workers: state.workers });
      if (
        state.workers.some(
          (w: any) => SWARM_VALIDATE_STATUSES.has(w.status) && w.pr != null
        )
      ) {
        reposToValidate.add(repo);
      }
    }
  } catch {
    /* state dir missing — no swarms yet */
  }

  // Validate the attention-status workers against real GitHub state (FIX 2), one
  // batched, ~60s-cached `gh pr list` per repo. Fails OPEN: a gh error yields an
  // empty map and reclassifyWorkerStatus keeps the orchestrator's status.
  const prStatesByRepo = new Map<string, Map<string, string>>();
  await Promise.all(
    [...reposToValidate].map(async (repo) => {
      prStatesByRepo.set(repo, await fetchRepoPrStates(repo));
    })
  );

  for (const entry of raw) {
    const prStates = prStatesByRepo.get(entry.repo) ?? new Map<string, string>();
    swarms.push({
      repo: entry.repo,
      updatedAt: entry.updatedAt,
      workers: entry.workers.map((w: any): SwarmWorkerView => {
        // GitHub reconciliation first (merged/closed drop the attention status),
        // then the existing 10-min stalled heuristic for in-flight workers.
        const reconciled = reclassifyWorkerStatus(
          entry.repo,
          { status: w.status, pr: w.pr ?? null },
          prStates
        );
        const status =
          entry.stale && (reconciled === "working" || reconciled === "pending")
            ? "stalled"
            : reconciled;
        return {
          name: w.name ?? null,
          branch: w.branch,
          task: w.task,
          status,
          pr: w.pr ?? null,
          rounds: w.rounds ?? 0,
          error: w.error,
          activity: tailLines(w.logFile, 4),
        };
      }),
    });
  }
  swarms.sort((a, b) => b.updatedAt - a.updatedAt);
  return Response.json({ swarms });
}
