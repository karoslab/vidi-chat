/**
 * Provider circuit breaker — a per-provider sliding-window breaker so a wedged
 * or repeatedly-erroring CLI stops burning tokens across the fleet. It trips
 * OPEN once the recent window holds at least `minSamples` results AND the
 * failure rate meets `threshold`; while open it fails fast until `cooldownMs`
 * elapses, then admits a single HALF-OPEN probe. The probe's outcome either
 * closes the breaker (recovered) or re-opens it for another cooldown. The clock
 * is injectable so tests never depend on wall time.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Max recent results retained; older ones roll off. */
  windowSize?: number;
  /** Don't trip until the window holds at least this many results. */
  minSamples?: number;
  /** Failure rate in [0,1] that trips the breaker. */
  threshold?: number;
  /** How long an open breaker waits before admitting a half-open probe. */
  cooldownMs?: number;
  /** Injectable clock (ms epoch); defaults to Date.now. */
  now?: () => number;
}

const DEFAULTS = {
  windowSize: 10,
  minSamples: 5,
  threshold: 0.5,
  cooldownMs: 30_000,
};

export class CircuitBreaker {
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** Recent results; true = failure. */
  private readonly window: boolean[] = [];
  private _state: BreakerState = "closed";
  private openedAt = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.windowSize = opts.windowSize ?? DEFAULTS.windowSize;
    this.minSamples = opts.minSamples ?? DEFAULTS.minSamples;
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    return this._state;
  }

  /**
   * Whether a request may proceed now. Mutating: an open breaker past its
   * cooldown flips to half-open and admits THIS caller as the lone probe;
   * further callers get false until the probe resolves.
   */
  allow(): boolean {
    if (
      this._state === "open" &&
      this.now() - this.openedAt >= this.cooldownMs
    ) {
      this._state = "half-open";
      return true;
    }
    return this._state === "closed";
  }

  recordSuccess(): void {
    if (this._state === "half-open") {
      this.reset();
      return;
    }
    this.push(false);
  }

  recordFailure(): void {
    if (this._state === "half-open") {
      this.open();
      return;
    }
    this.push(true);
    if (
      this.window.length >= this.minSamples &&
      this.failureRate() >= this.threshold
    ) {
      this.open();
    }
  }

  private failureRate(): number {
    if (this.window.length === 0) return 0;
    const failures = this.window.reduce((n, f) => n + (f ? 1 : 0), 0);
    return failures / this.window.length;
  }

  private push(failure: boolean): void {
    this.window.push(failure);
    if (this.window.length > this.windowSize) this.window.shift();
  }

  private open(): void {
    this._state = "open";
    this.openedAt = this.now();
  }

  private reset(): void {
    this._state = "closed";
    this.window.length = 0;
  }
}
