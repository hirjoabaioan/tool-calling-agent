import { describe, expect, it } from 'vitest';
import { Meter } from '../metering/meter.js';
import { MockProvider } from '../providers/mock.js';
import { ProviderError, type ErrorKind } from '../providers/types.js';
import { CircuitBreaker } from './breaker.js';
import { costUsd } from './pricing.js';
import { routesFor } from './routes.js';
import { AllRoutesFailedError, Router } from './router.js';

const ROUTES = [
  { provider: 'a', model: 'claude-haiku-4-5' },
  { provider: 'b', model: 'gpt-4.1-mini' },
];
const req = { purpose: 'assistant', runId: 'r1', step: 1, system: 's', messages: [], tools: [] };

function setup() {
  const a = new MockProvider('a');
  const b = new MockProvider('b');
  const meter = new Meter(':memory:');
  const sleeps: number[] = [];
  let t = 0;
  const now = () => (t += 5);
  const router = new Router({
    providers: { a, b },
    routes: () => ROUTES,
    meter,
    now,
    breaker: new CircuitBreaker({ now }),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  return { a, b, meter, sleeps, router };
}

describe('retryable errors', () => {
  it.each<ErrorKind>(['rate_limit', 'server', 'timeout'])('%s is retried twice with backoff, then falls back', async (kind) => {
    const { a, b, router, sleeps, meter } = setup();
    a.push(new ProviderError(kind, 'x'), new ProviderError(kind, 'x'), new ProviderError(kind, 'x'));
    b.push({ text: 'from b' });
    const res = await router.chat(req);
    expect(a.calls).toHaveLength(3);
    expect(sleeps).toEqual([400 + 200, 800 + 200]);
    expect(res).toMatchObject({ provider: 'b', fallback: true, fallbackReason: kind });
    const rows = meter.rows();
    expect(rows.map((r) => [r.provider, r.attempt, r.success, r.error_kind])).toEqual([
      ['a', 1, 0, kind], ['a', 2, 0, kind], ['a', 3, 0, kind], ['b', 1, 1, null],
    ]);
  });

  it('succeeds on a retry without falling back', async () => {
    const { a, router } = setup();
    a.push(new ProviderError('server', 'x'), { text: 'ok' });
    const res = await router.chat(req);
    expect(res).toMatchObject({ provider: 'a', attempts: 2, fallback: false });
  });
});

describe('non-retryable errors', () => {
  it.each<ErrorKind>(['quota', 'auth', 'bad_request'])('%s skips straight to the next route', async (kind) => {
    const { a, b, router, sleeps } = setup();
    a.push(new ProviderError(kind, 'x'));
    b.push({ text: 'from b' });
    const res = await router.chat(req);
    expect(a.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(res).toMatchObject({ provider: 'b', fallback: true, fallbackReason: kind });
  });
});

describe('router misc', () => {
  it('throws AllRoutesFailedError listing every failure', async () => {
    const { a, b, router } = setup();
    a.push(new ProviderError('auth', 'x'));
    b.push(new ProviderError('quota', 'x'));
    const err = await router.chat(req).catch((e) => e);
    expect(err).toBeInstanceOf(AllRoutesFailedError);
    expect(err.failures).toEqual([{ provider: 'a', reason: 'auth' }, { provider: 'b', reason: 'quota' }]);
  });

  it('skips a provider whose breaker is open without calling it', async () => {
    const { a, b, router } = setup();
    for (let i = 0; i < 3; i++) a.push(new ProviderError('auth', 'x'));
    for (let i = 0; i < 4; i++) b.push({ text: 'ok' });
    for (let i = 0; i < 3; i++) await router.chat(req);
    const callsBefore = a.calls.length;
    const res = await router.chat(req);
    expect(a.calls).toHaveLength(callsBefore);
    expect(res).toMatchObject({ provider: 'b', fallbackReason: 'circuit_open' });
  });

  it('meters successful calls with tokens, duration and cost', async () => {
    const { a, router, meter } = setup();
    a.push({ text: 'ok', usage: { in: 2000, out: 500 } });
    await router.chat(req);
    const row = meter.rows()[0];
    expect(row).toMatchObject({ provider: 'a', tokens_in: 2000, tokens_out: 500, success: 1, fallback: 0, purpose: 'assistant', step: 1 });
    expect(row?.cost_usd).toBeCloseTo((2000 * 1 + 500 * 5) / 1e6);
    expect(row?.duration_ms).toBeGreaterThan(0);
  });
});

describe('pricing and routes', () => {
  it('returns null for unknown models, not 0', () => {
    expect(costUsd('mystery-model', 1000, 1000)).toBeNull();
    expect(costUsd('gpt-4.1-mini', 1_000_000, 0)).toBeCloseTo(0.4);
  });

  it('lets env override model ids', () => {
    expect(routesFor('assistant', {})[0]).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(routesFor('assistant', { ANTHROPIC_MODEL: 'custom-model' })[0]?.model).toBe('custom-model');
    expect(() => routesFor('unknown')).toThrow();
  });
});
