export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold?: number;
  windowMs?: number;
  openMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  openedAt?: number;
  probing: boolean;
}

/** Per-key breaker: opens after N failures inside a window, then lets exactly one probe through after a cool-down. */
export class CircuitBreaker {
  private entries = new Map<string, Entry>();
  private threshold: number;
  private windowMs: number;
  private openMs: number;
  private now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;
    this.openMs = opts.openMs ?? 120_000;
    this.now = opts.now ?? Date.now;
  }

  state(key: string): BreakerState {
    const e = this.entries.get(key);
    if (e?.openedAt === undefined) return 'closed';
    return this.now() - e.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  /** Call before each attempt. In half-open state only the first caller gets the probe. */
  allow(key: string): boolean {
    const state = this.state(key);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const e = this.entry(key);
    if (e.probing) return false;
    e.probing = true;
    return true;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  recordFailure(key: string): void {
    const e = this.entry(key);
    const t = this.now();
    if (e.openedAt !== undefined) {
      // Failed probe: restart the cool-down.
      e.openedAt = t;
      e.probing = false;
      return;
    }
    e.failures = [...e.failures.filter((f) => t - f < this.windowMs), t];
    if (e.failures.length >= this.threshold) e.openedAt = t;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { failures: [], probing: false }));
    return e;
  }
}
