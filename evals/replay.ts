import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatResponse, Provider } from '../src/providers/types.js';

export interface RecordedStep {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage: { in: number; out: number };
  latencyMs: number;
}

export interface FixtureCase {
  /** Present only on cases that are wrong on purpose; the value says why. */
  deliberateFailure?: string;
  steps: Record<string, RecordedStep>;
}

export interface Fixtures {
  route: { provider: string; model: string };
  cases: Record<string, FixtureCase>;
}

export function loadFixtures(dir: string): Fixtures {
  const merged: Fixtures = { route: { provider: 'replay', model: 'claude-haiku-4-5' }, cases: {} };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixtures;
    merged.route = data.route;
    Object.assign(merged.cases, data.cases);
  }
  return merged;
}

/** A virtual clock lets replay report the recorded latency without sleeping. */
export class VirtualClock {
  t = 0;
  now = (): number => this.t;
}

/** Serves recorded responses by (case, step). Never touches the network. */
export class ReplayProvider implements Provider {
  readonly name = 'replay';
  private caseId = '';
  private step = 0;

  constructor(
    private fixtures: Fixtures,
    private clock: VirtualClock,
  ) {}

  begin(caseId: string): void {
    this.caseId = caseId;
    this.step = 0;
  }

  async chat(): Promise<ChatResponse> {
    const rec = this.fixtures.cases[this.caseId]?.steps[String(++this.step)];
    if (!rec) throw new Error(`No recorded response for case ${this.caseId} step ${this.step}`);
    this.clock.t += rec.latencyMs;
    return {
      text: rec.text,
      toolCalls: rec.toolCalls?.map((c, i) => ({ id: `replay-${this.step}-${i}`, name: c.name, args: c.args })),
      usage: rec.usage,
    };
  }
}
