import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent/loop.js';
import { ProposalStore } from '../src/agent/proposals.js';
import { Store } from '../src/domain/store.js';
import { Meter } from '../src/metering/meter.js';
import { percentile } from '../src/metering/report.js';
import { providersFromEnv } from '../src/providers/index.js';
import type { ChatRequest, ChatResponse, Provider } from '../src/providers/types.js';
import { Router } from '../src/router/router.js';
import { routesFor, type Route } from '../src/router/routes.js';
import { makeActor } from '../src/tools/rbac.js';
import { loadFixtures, ReplayProvider, VirtualClock, type Fixtures } from './replay.js';
import { score } from './scorers.js';
import { GROUPS, type EvalCase, type Group, type RecordedCall } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixed "now" and seed anchor so every case sees identical data and relative dates.
const NOW = new Date('2026-10-19T08:00:00Z');
const ANCHOR = new Date('2026-10-19T00:00:00Z');

export interface CaseResult {
  id: string;
  group: Group;
  pass: boolean;
  failures: string[];
  calls: string[];
  outcome: string;
  deliberateFailure?: string;
}

export interface ModelRun {
  label: string;
  cases: CaseResult[];
  costUsd: number;
  costIncomplete: boolean;
  calls: number;
  p50Ms: number;
  p95Ms: number;
}

export function loadCases(dir = join(HERE, 'cases'), group?: string): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvalCase))
    .filter((c) => !group || c.group === group);
}

/** Captures what the model asked for, independent of what the loop then allowed. */
class Recorder implements Provider {
  calls: RecordedCall[] = [];
  constructor(private inner: Provider) {}
  get name(): string {
    return this.inner.name;
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.inner.chat(req);
    for (const c of res.toolCalls ?? []) this.calls.push({ name: c.name, args: c.args });
    return res;
  }
}

interface Target {
  label: string;
  providers: Record<string, Provider>;
  routes: Route[];
  begin?: (caseId: string) => void;
  clock?: VirtualClock;
}

export async function runTarget(target: Target, cases: EvalCase[], fixtures?: Fixtures): Promise<ModelRun> {
  const meter = new Meter(':memory:');
  const results: CaseResult[] = [];
  for (const c of cases) {
    const store = Store.seeded(42, ANCHOR);
    for (const n of c.seedOverrides?.notes ?? []) store.addNote({ clientId: n.clientId, author: n.author ?? 'Staff', text: n.text }, NOW);
    target.begin?.(c.id);
    const recorders = Object.fromEntries(Object.entries(target.providers).map(([k, p]) => [k, new Recorder(p)]));
    const router = new Router({ providers: recorders, routes: () => target.routes, meter, now: target.clock?.now, sleep: async () => {} });
    const actor = makeActor(c.actor.role, c.actor.id, c.actor.clientId, c.actor.permissions);
    const result = await runAgent({
      messages: c.messages, actor, router, store, proposals: new ProposalStore(), meter, now: () => NOW, runId: `${target.label}:${c.id}`,
    });
    const calls = Object.values(recorders).flatMap((r) => r.calls);
    const s = score(c, calls, result);
    results.push({
      id: c.id, group: c.group, pass: s.pass, failures: s.failures, calls: calls.map((x) => x.name),
      outcome: result.kind === 'proposal' ? `proposal:${result.proposal.tool}` : result.kind,
      deliberateFailure: fixtures?.cases[c.id]?.deliberateFailure,
    });
  }
  // Agent-level refusals are metered with provider 'agent' and zero duration; only real provider calls count here.
  const rows = meter.rows().filter((r) => r.provider !== 'agent' && r.success === 1);
  const durations = rows.map((r) => r.duration_ms);
  meter.close();
  return {
    label: target.label, cases: results,
    costUsd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    costIncomplete: rows.some((r) => r.cost_usd === null),
    calls: rows.length, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95),
  };
}

export async function runReplay(cases: EvalCase[], fixturesDir = join(HERE, 'fixtures')): Promise<ModelRun> {
  const fixtures = loadFixtures(fixturesDir);
  const clock = new VirtualClock();
  const provider = new ReplayProvider(fixtures, clock);
  const { provider: name, model } = fixtures.route;
  return runTarget(
    { label: `replay (${model}, hand-authored)`, providers: { [name]: provider }, routes: [{ provider: name, model }], begin: (id) => provider.begin(id), clock },
    cases,
    fixtures,
  );
}

const KEY_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
};

/** `--models` is "default" (the assistant purpose route, honouring *_MODEL env overrides) or provider:model pairs. */
export function liveTargets(spec: string, log: (m: string) => void = console.log, env = process.env): Target[] {
  const available = providersFromEnv(env);
  const targets: Target[] = [];
  if (spec === 'default') {
    const routes = routesFor('assistant', env).filter((r) => available[r.provider]);
    if (routes.length === 0) log('skipping "default" route: no provider API keys are set (see .env.example)');
    else targets.push({ label: `assistant route (${routes.map((r) => `${r.provider}:${r.model}`).join(' > ')})`, providers: available, routes });
    return targets;
  }
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    const provider = item.slice(0, i);
    const model = item.slice(i + 1);
    if (i < 1 || !model) log(`skipping "${item}": expected provider:model`);
    else if (!(provider in KEY_VARS)) log(`skipping "${item}": unknown provider (use ${Object.keys(KEY_VARS).join(', ')})`);
    else if (!available[provider]) log(`skipping "${item}": ${KEY_VARS[provider]} is not set`);
    else targets.push({ label: item, providers: { [provider]: available[provider] as Provider }, routes: [{ provider, model }] });
  }
  return targets;
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}% (${n}/${d})`);

export function formatMarkdown(runs: ModelRun[], mode: 'live' | 'replay', stamp: string): string {
  const header = '| Model | ' + GROUPS.join(' | ') + ' | overall | cost (USD) | p50 ms | p95 ms |';
  const lines = [
    '# Eval results',
    '',
    mode === 'replay'
      ? 'Mode: offline replay of hand-authored fixtures (no network). Latency is the recorded latency; cost is computed from recorded token counts at list prices.'
      : `Mode: live, run at ${stamp}. Cost and latency are taken from the meter (one row per provider call).`,
    '',
    header,
    '|' + Array(GROUPS.length + 5).fill('---').join('|') + '|',
  ];
  for (const r of runs) {
    const per = GROUPS.map((g) => {
      const cs = r.cases.filter((c) => c.group === g);
      return pct(cs.filter((c) => c.pass).length, cs.length);
    });
    const cost = r.calls === 0 ? 'n/a' : `${r.costUsd.toFixed(5)}${r.costIncomplete ? '*' : ''}`;
    lines.push(`| ${r.label} | ${per.join(' | ')} | ${pct(r.cases.filter((c) => c.pass).length, r.cases.length)} | ${cost} | ${r.p50Ms} | ${r.p95Ms} |`);
  }
  if (runs.some((r) => r.costIncomplete)) lines.push('', '`*` some calls used a model without a price entry and are excluded from the cost.');
  for (const r of runs) {
    const failed = r.cases.filter((c) => !c.pass);
    if (failed.length === 0) continue;
    lines.push('', `## Failures: ${r.label}`, '');
    for (const c of failed) lines.push(`- \`${c.id}\` (${c.group})${c.deliberateFailure ? ' **deliberate**' : ''}: ${c.failures.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const replay = argv.includes('--replay');
  const group = arg(argv, '--group');
  if (group && !(GROUPS as readonly string[]).includes(group)) {
    console.error(`Unknown group "${group}". Groups: ${GROUPS.join(', ')}`);
    return 2;
  }
  const cases = loadCases(undefined, group);
  const outDir = arg(argv, '--out') ?? join(HERE, 'results');
  let runs: ModelRun[];
  if (replay) {
    runs = [await runReplay(cases)];
  } else {
    runs = [];
    for (const t of liveTargets(arg(argv, '--models') ?? 'default')) {
      console.log(`running ${cases.length} cases against ${t.label} ...`);
      runs.push(await runTarget(t, cases));
    }
    if (runs.length === 0) {
      console.error('No runnable models. Set provider keys in .env or use --replay.');
      return 2;
    }
  }

  const mode = replay ? 'replay' : 'live';
  const stamp = new Date().toISOString();
  const md = formatMarkdown(runs, mode, stamp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp.replace(/[:.]/g, '-')}.json`), JSON.stringify({ mode, stamp, runs }, null, 2) + '\n');
  writeFileSync(join(outDir, 'latest.md'), md);
  console.log(md);

  if (replay) {
    // Replay is a regression check: exactly the deliberately broken cases must fail, nothing else.
    const run = runs[0] as ModelRun;
    const unexpected = run.cases.filter((c) => c.pass === Boolean(c.deliberateFailure));
    if (unexpected.length) {
      console.error(`Replay mismatch: ${unexpected.map((c) => c.id).join(', ')} did not score as the fixtures declare.`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
