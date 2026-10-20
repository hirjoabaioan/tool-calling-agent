import type { MeterSink } from '../metering/meter.js';
import { classifyError } from '../providers/errors.js';
import { ProviderError, RETRYABLE, type ChatRequest, type ChatResponse, type Message, type Provider, type ToolSpec } from '../providers/types.js';
import { CircuitBreaker } from './breaker.js';
import { costUsd } from './pricing.js';
import { routesFor, type Route } from './routes.js';

export interface RouterRequest {
  purpose: string;
  runId: string;
  step: number;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  timeoutMs?: number;
}

export interface RouterResult {
  response: ChatResponse;
  provider: string;
  model: string;
  costUsd: number | null;
  durationMs: number;
  /** Attempts made on the route entry that finally succeeded. */
  attempts: number;
  fallback: boolean;
  fallbackReason?: string;
}

export class AllRoutesFailedError extends Error {
  constructor(public readonly failures: { provider: string; reason: string }[]) {
    super(`All routes failed: ${failures.map((f) => `${f.provider}=${f.reason}`).join(', ')}`);
    this.name = 'AllRoutesFailedError';
  }
}

export interface RouterOptions {
  providers: Record<string, Provider>;
  routes?: (purpose: string) => Route[];
  breaker?: CircuitBreaker;
  meter?: MeterSink;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  defaultTimeoutMs?: number;
}

export class Router {
  private providers: Record<string, Provider>;
  private routes: (purpose: string) => Route[];
  private breaker: CircuitBreaker;
  private meter?: MeterSink;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private maxRetries: number;
  private baseDelayMs: number;
  private defaultTimeoutMs: number;

  constructor(o: RouterOptions) {
    this.providers = o.providers;
    this.routes = o.routes ?? ((purpose) => routesFor(purpose));
    this.now = o.now ?? Date.now;
    this.breaker = o.breaker ?? new CircuitBreaker({ now: this.now });
    this.meter = o.meter;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.maxRetries = o.maxRetries ?? 2;
    this.baseDelayMs = o.baseDelayMs ?? 400;
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? 30_000;
  }

  async chat(req: RouterRequest): Promise<RouterResult> {
    const failures: { provider: string; reason: string }[] = [];
    let fallbackReason: string | undefined;

    for (const [index, route] of this.routes(req.purpose).entries()) {
      const provider = this.providers[route.provider];
      if (!provider) {
        fallbackReason = 'unconfigured';
        continue;
      }
      for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
        if (!this.breaker.allow(route.provider)) {
          fallbackReason = 'circuit_open';
          failures.push({ provider: route.provider, reason: 'circuit_open' });
          break;
        }
        const chatReq: ChatRequest = {
          model: route.model,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs,
        };
        const started = this.now();
        try {
          const response = await provider.chat(chatReq);
          const durationMs = this.now() - started;
          this.breaker.recordSuccess(route.provider);
          const cost = costUsd(route.model, response.usage.in, response.usage.out);
          this.record(req, route, attempt, index > 0, durationMs, response.usage, cost, undefined);
          return {
            response, provider: route.provider, model: route.model, costUsd: cost, durationMs,
            attempts: attempt, fallback: index > 0, fallbackReason: index > 0 ? fallbackReason : undefined,
          };
        } catch (e) {
          const err: ProviderError = classifyError(e);
          const durationMs = this.now() - started;
          this.record(req, route, attempt, index > 0, durationMs, { in: 0, out: 0 }, null, err.kind);
          // A malformed request is our bug, not the provider's health.
          if (err.kind !== 'bad_request') this.breaker.recordFailure(route.provider);
          fallbackReason = err.kind;
          failures.push({ provider: route.provider, reason: err.kind });
          if (!RETRYABLE.has(err.kind) || attempt > this.maxRetries) break;
          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) + this.random() * this.baseDelayMs);
        }
      }
    }
    throw new AllRoutesFailedError(failures);
  }

  private record(
    req: RouterRequest, route: Route, attempt: number, fallback: boolean, durationMs: number,
    usage: { in: number; out: number }, cost: number | null, errorKind: string | undefined,
  ): void {
    this.meter?.record({
      runId: req.runId, purpose: req.purpose, provider: route.provider, model: route.model, attempt,
      success: errorKind === undefined, errorKind, fallback, durationMs,
      tokensIn: usage.in, tokensOut: usage.out, costUsd: cost, step: req.step,
    });
  }
}
