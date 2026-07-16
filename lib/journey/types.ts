/**
 * Vidi Journey — the step contract (design of record 2026-07-11).
 *
 * A journey is an ordered set of steps that take a brand-new, non-technical
 * customer from "just installed" to "fully set up". The whole framework rests
 * on one property: you can never get lost. Position is NOT stored — it is
 * RECOMPUTED every time by running each step's verify() down the registry and
 * stopping at the first one that fails. data/journey.json is only a cache of the
 * last computed result (for timestamps / instant paint); it never decides where
 * you are.
 *
 * Verification is MECHANICAL. verify() inspects real state — the filesystem, a
 * CLI's login status, an API — and answers "is this actually true right now".
 * It must NEVER encode "did the user click through this screen": a customer who
 * clicked Next but whose connection later broke is NOT done, and the journey has
 * to know that on its own.
 */

/** The outcome of one mechanical check. */
export type VerifyResult =
  | { ok: true; note?: string }
  | { ok: false; reason: string; fixStepId?: string };

/**
 * One step in the journey. The REQUIRED surface is exactly { id, stage, title,
 * verify } — that is the contract every stage module implements. The optional
 * fields power the shared step UI (StepFrame / SetupHealth); a step that omits
 * them still verifies correctly, it just renders with generic copy. Stage
 * modules SHOULD supply why + outcome so the screen reads well.
 */
export interface JourneyStep {
  /** Stable, unique, kebab-case. Used as the deep-link target and cache key. */
  id: string;
  /** Which stage this belongs to (1 = foundation … 5 = approvals). Steps render
   *  and resume in registry order; stage groups the eyebrow label. */
  stage: number;
  /** Short, plain, customer-facing. Never uses the words repo / CLI / token. */
  title: string;

  /** One sentence: why this step matters, in the customer's language. */
  why?: string;
  /** What the customer should see when this step is genuinely done. */
  outcome?: string;
  /** The ONE primary action the step screen offers (a link + label). Optional —
   *  a check-only step (e.g. "Vidi is running") needs none. */
  primaryAction?: { label: string; href: string };

  /**
   * Optional by design: a step the journey must NEVER block on. When a skippable
   * step's verify() returns ok:false, the engine records it as "skipped" (not
   * "failed"): it does not become the resume point and it does not stop later
   * steps or completion. Used by the Discord mirror in Stage 5, which degrades
   * to in-app-only when it isn't connected.
   */
  skippable?: boolean;

  /**
   * The mechanical check. Resolves ok:true when the real state is satisfied,
   * else ok:false with a plain-language `reason` the customer can act on (never
   * raw stderr). MUST NOT throw — the engine treats a throw as a soft failure,
   * but a well-behaved step returns ok:false instead.
   */
  verify(): Promise<VerifyResult>;
}

/** Per-step result after the engine runs a pass. */
export interface StepState {
  id: string;
  stage: number;
  title: string;
  /**
   * verified — verify() returned ok:true.
   * failed   — verify() returned ok:false (this is the resume point; there is
   *            at most one per pass, the FIRST failure).
   * pending  — a step AFTER the first failure: not evaluated this pass because
   *            it depends on the broken step being fixed first (the grey dash).
   * skipped  — an optional (skippable) step whose verify() returned ok:false.
   *            It never blocks: not a resume point, does not stop later steps or
   *            completion. `reason` still carries the plain "you can set this up"
   *            note so the customer can act on it if they want.
   */
  status: "verified" | "failed" | "pending" | "skipped";
  /** Plain-language reason, present only when status === "failed". */
  reason?: string;
  /** Optional confirming note, present only when status === "verified". */
  note?: string;
  /** Where to send the customer to fix a failure (defaults to the step id). */
  fixStepId?: string;
  /** ISO time this step was actually run (absent for pending steps). */
  checkedAt?: string;

  // Static UI content carried through so the client can render without knowing
  // about the (server-only) verify function.
  why?: string;
  outcome?: string;
  primaryAction?: { label: string; href: string };
}

/** The whole verified journey — what GET /api/journey returns. */
export interface JourneyState {
  steps: StepState[];
  /** The first failing step's id, or null when every step verified. This is the
   *  single source of "where you are". */
  currentStepId: string | null;
  /** True when every step verified. */
  complete: boolean;
  /** ISO time this whole pass was computed. */
  computedAt: string;
}
