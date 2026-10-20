import { pathToFileURL } from 'node:url';
import { Meter, type CallRow } from './meter.js';

export interface GroupStats {
  key: string;
  calls: number;
  successRate: number;
  fallbackRate: number;
  p50Ms: number;
  p95Ms: number;
  avgCostUsd: number | null;
  totalCostUsd: number;
}

/** Nearest-rank percentile: the smallest value with at least p% of samples at or below it. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

function summarize(key: string, rows: CallRow[]): GroupStats {
  const costs = rows.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  const total = costs.reduce((a, b) => a + b, 0);
  const durations = rows.map((r) => r.duration_ms);
  return {
    key,
    calls: rows.length,
    successRate: rows.filter((r) => r.success === 1).length / rows.length,
    fallbackRate: rows.filter((r) => r.fallback === 1).length / rows.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    avgCostUsd: costs.length ? total / costs.length : null,
    totalCostUsd: total,
  };
}

function groupBy(rows: CallRow[], keyOf: (r: CallRow) => string): GroupStats[] {
  const groups = new Map<string, CallRow[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => summarize(k, rs));
}

export function buildReport(rows: CallRow[]) {
  return {
    byPurpose: groupBy(rows, (r) => r.purpose),
    byModel: groupBy(rows, (r) => `${r.provider}/${r.model}`),
  };
}

function table(title: string, stats: GroupStats[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(5)}`);
  const header = `${title.padEnd(36)} calls  ok    fallback  p50ms  p95ms  avg cost    total cost`;
  const lines = stats.map(
    (s) =>
      `${s.key.padEnd(36)} ${String(s.calls).padEnd(6)} ${pct(s.successRate).padEnd(5)} ${pct(s.fallbackRate).padEnd(9)} ` +
      `${String(s.p50Ms).padEnd(6)} ${String(s.p95Ms).padEnd(6)} ${usd(s.avgCostUsd).padEnd(11)} ${usd(s.totalCostUsd)}`,
  );
  return [header, ...lines].join('\n');
}

export function formatReport(rows: CallRow[]): string {
  if (rows.length === 0) return 'No calls recorded yet.';
  const r = buildReport(rows);
  return [table('purpose', r.byPurpose), '', table('provider/model', r.byModel)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const meter = new Meter();
  console.log(formatReport(meter.rows()));
  meter.close();
}
