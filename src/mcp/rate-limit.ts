export interface BucketOptions {
  /** Tokens per minute; also the burst capacity. */
  perMinute: number;
  now?: () => number;
}

/** Classic token bucket, one bucket per key, refilled continuously. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private now: () => number;
  private perMinute: number;

  constructor(o: BucketOptions) {
    this.perMinute = o.perMinute;
    this.now = o.now ?? Date.now;
  }

  /** Returns 0 when allowed, otherwise the number of seconds until a token is available. */
  take(key: string): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / this.perMinute) * 60);
  }
}
