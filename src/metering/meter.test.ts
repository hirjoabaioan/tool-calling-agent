import { describe, expect, it } from 'vitest';
import { Meter, type CallRecord } from './meter.js';
import { buildReport, formatReport, percentile } from './report.js';

const base: CallRecord = {
  runId: 'r', purpose: 'assistant', provider: 'a', model: 'm', attempt: 1, success: true, fallback: false,
  durationMs: 100, tokensIn: 10, tokensOut: 5, costUsd: 0.01, step: 1,
};

describe('Meter', () => {
  it('stores one row per record with the injected timestamp', () => {
    const meter = new Meter(':memory:', () => 1234);
    meter.record(base);
    meter.record({ ...base, success: false, errorKind: 'server', costUsd: null, attempt: 2, fallback: true });
    const rows = meter.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: 1234, run_id: 'r', success: 1, error_kind: null, cost_usd: 0.01, fallback: 0 });
    expect(rows[1]).toMatchObject({ success: 0, error_kind: 'server', cost_usd: null, attempt: 2, fallback: 1 });
  });
});

describe('percentile', () => {
  it('uses nearest-rank on sorted data', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('report', () => {
  it('groups by purpose and provider/model with rates, percentiles and costs', () => {
    const meter = new Meter(':memory:');
    for (let i = 1; i <= 20; i++) meter.record({ ...base, durationMs: i * 10, costUsd: 0.02 });
    meter.record({ ...base, success: false, errorKind: 'server', durationMs: 1000, costUsd: null, fallback: true });
    meter.record({ ...base, purpose: 'mcp', provider: 'x', model: 'y', costUsd: null });
    const report = buildReport(meter.rows());

    const assistant = report.byPurpose.find((g) => g.key === 'assistant');
    expect(assistant).toMatchObject({ calls: 21, p50Ms: 110, p95Ms: 200 });
    expect(assistant?.successRate).toBeCloseTo(20 / 21);
    expect(assistant?.fallbackRate).toBeCloseTo(1 / 21);
    expect(assistant?.totalCostUsd).toBeCloseTo(0.4);
    expect(assistant?.avgCostUsd).toBeCloseTo(0.02);

    expect(report.byPurpose.map((g) => g.key)).toEqual(['assistant', 'mcp']);
    expect(report.byModel.map((g) => g.key)).toEqual(['a/m', 'x/y']);
    expect(report.byModel[1]?.avgCostUsd).toBeNull();
    expect(formatReport(meter.rows())).toContain('a/m');
  });

  it('handles an empty meter', () => {
    expect(formatReport([])).toMatch(/No calls/);
  });
});
