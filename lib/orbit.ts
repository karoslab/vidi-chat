/**
 * Orbit scene derivation — the pure logic behind the "Orbit" home view.
 *
 * The solar-system home (components/Chat.tsx) is wired to REAL data: thread
 * planets on the inner ring, fleet chips on the outer ring, and a caption
 * computed from how many agents are actually working. Keeping that math here
 * (not inline in the component) means it can be unit-tested and can't silently
 * drift — the caption's grammar and the ring geometry are both easy to get
 * subtly wrong.
 */

/** Small-number words so the caption reads "Two agents are working." (per the
 *  design) rather than "2 agents". Falls back to digits past ten. */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function numberWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/** Capitalize the first letter (caption sits at the start of a sentence). */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The line under the solar system. Zero working agents is the calm case
 * ("Everything is quiet."); otherwise it names the count with subject/verb
 * agreement so it always reads as real English.
 */
export function workingCaption(workingCount: number): string {
  const n = Math.max(0, Math.floor(workingCount));
  if (n === 0) return "Everything is quiet.";
  const noun = n === 1 ? "agent is" : "agents are";
  return `Everything is quiet. ${cap(numberWord(n))} ${noun} working.`;
}

/** A single position on a ring, as PERCENTAGES of the ring's bounding box
 *  (0..100 on each axis) so the component can place chips with left/top %. */
export interface RingSlot {
  xPct: number;
  yPct: number;
  angleDeg: number;
}

/**
 * Evenly space `count` items around a ring, starting at 12 o'clock and going
 * clockwise. The ring box is treated as a square whose center is (50%, 50%)
 * and whose radius is half its width, so a slot at angle 0 sits at the top
 * (50%, 0%), 90° at the right (100%, 50%), etc. `startDeg` rotates the whole
 * set (used to keep a small number of planets off the exact top/bottom).
 */
export function ringSlots(count: number, startDeg = 0): RingSlot[] {
  if (count <= 0) return [];
  const slots: RingSlot[] = [];
  for (let i = 0; i < count; i++) {
    const angleDeg = startDeg + (360 / count) * i;
    const theta = (angleDeg * Math.PI) / 180;
    const xPct = 50 + 50 * Math.sin(theta);
    const yPct = 50 - 50 * Math.cos(theta);
    slots.push({ xPct, yPct, angleDeg });
  }
  return slots;
}

/** Status-dot classification shared by the outer orbit and the Fleet page,
 *  mapping the many raw swarm/agent statuses onto the four dot colors the
 *  design specifies (working amber-pulse, merged/idle green, PR-open blue). */
export type FleetDot = "working" | "merged" | "pr-open" | "idle";

export interface FleetChipInput {
  swarms: { repo: string; workers: { status: string; pr: number | null }[] }[];
  agents: { name: string; status: string }[];
}

export interface FleetChip {
  key: string;
  label: string;
  dot: FleetDot;
  /** The dot pulses only for genuinely live/attention states. */
  pulse: boolean;
}

/** Count of agents + swarm workers that are actively running right now — the
 *  number the home caption reports. */
export function workingCount(input: FleetChipInput): number {
  const agentsWorking = input.agents.filter((a) => a.status === "working").length;
  const swarmWorking = input.swarms.reduce(
    (sum, s) => sum + s.workers.filter((w) => w.status === "working").length,
    0
  );
  return agentsWorking + swarmWorking;
}

/**
 * Reduce raw swarm repos + fleet agents to the handful of chips that ride the
 * OUTER orbit on the home scene. One chip per repo (showing its most
 * attention-worthy state) plus one per working agent, capped so the ring never
 * overflows. Repos with no meaningful state (all idle/closed) are dropped.
 */
export function fleetChips(input: FleetChipInput, cap = 5): FleetChip[] {
  const chips: FleetChip[] = [];

  for (const s of input.swarms) {
    const working = s.workers.filter((w) => w.status === "working");
    const review = s.workers.filter(
      (w) => w.status === "pr-open" || w.status === "pending-approval"
    );
    const merged = s.workers.filter((w) => w.status === "merged");

    if (working.length > 0) {
      chips.push({
        key: `swarm:${s.repo}`,
        label: `swarm: ${s.repo} · ${working.length} working`,
        dot: "working",
        pulse: true,
      });
    } else if (review.length > 0) {
      const pr = review.find((w) => w.pr != null)?.pr ?? null;
      const pendingApproval = review.some((w) => w.status === "pending-approval");
      chips.push({
        key: `swarm:${s.repo}`,
        label: pr != null ? `PR #${pr} · in review` : `${s.repo} · in review`,
        dot: "pr-open",
        pulse: pendingApproval,
      });
    } else if (merged.length > 0) {
      chips.push({
        key: `swarm:${s.repo}`,
        label: `swarm: ${s.repo} · ${merged.length} merged`,
        dot: "merged",
        pulse: false,
      });
    }
    // else: repo has only idle/closed workers — nothing worth a chip.
  }

  for (const a of input.agents) {
    if (a.status === "working") {
      chips.push({
        key: `agent:${a.name}`,
        label: `${a.name} · working`,
        dot: "working",
        pulse: true,
      });
    }
  }

  return chips.slice(0, cap);
}
