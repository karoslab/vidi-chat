/**
 * Sidebar swarm view — what a swarm strip in the LEFT NAV should show.
 *
 * The sidebar is a "needs your eyes" surface, not the full board (that lives on
 * /canvas). A worker drops off the strip the moment its job is terminal —
 * MERGED, CLOSED, rejected, or any in-flight/finished state that no longer needs
 * the owner. The only entries that STAY are:
 *   - `pending-approval` — waiting on the owner's `APPROVE PR n` in Discord.
 *   - `review-error`     — the reviewer itself errored; a human has to look.
 *     (Judgment call: an error isn't "awaiting approval", but silently hiding a
 *      broken review would lose it — errors need eyes, so they stay. Flagged in
 *      the PR body.)
 * Everything else — merged, closed, rejected, working, pending, pr-open, failed,
 * merge-failed, needs-human, stalled — is hidden from the sidebar.
 *
 * A repo group with zero visible workers disappears entirely (including its
 * "N merged ✓" tally). If no repo has a visible worker, the caller renders no
 * SWARM section at all.
 */
export const SWARM_ATTENTION_STATUSES = new Set(["pending-approval", "review-error"]);

/** Minimal shape this filter needs — a superset of the sidebar's SwarmRepoLite. */
export interface SwarmWorkerLike {
  status: string;
}
export interface SwarmRepoLike<W extends SwarmWorkerLike = SwarmWorkerLike> {
  repo: string;
  workers: W[];
}

export interface AttentionSwarm<W extends SwarmWorkerLike = SwarmWorkerLike> {
  repo: string;
  /** Only the workers that still need the owner (pending-approval / review-error). */
  visible: W[];
  /** How many of this repo's workers merged — context alongside the visible ones. */
  merged: number;
}

/**
 * Reduce raw swarm repos to only the repos (and workers) that belong in the
 * sidebar. Repos with nothing visible are dropped, so an empty result means
 * "render no SWARM section".
 */
export function attentionSwarms<W extends SwarmWorkerLike>(
  swarms: SwarmRepoLike<W>[]
): AttentionSwarm<W>[] {
  const out: AttentionSwarm<W>[] = [];
  for (const s of swarms) {
    const visible = s.workers.filter((w) => SWARM_ATTENTION_STATUSES.has(w.status));
    if (visible.length === 0) continue;
    out.push({
      repo: s.repo,
      visible,
      merged: s.workers.filter((w) => w.status === "merged").length,
    });
  }
  return out;
}
