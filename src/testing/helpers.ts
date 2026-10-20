import { ProposalStore } from '../agent/proposals.js';
import { runAgent, type RunAgentOptions } from '../agent/loop.js';
import { Store } from '../domain/store.js';
import { Meter } from '../metering/meter.js';
import { MockProvider } from '../providers/mock.js';
import type { Message } from '../providers/types.js';
import { Router } from '../router/router.js';
import type { Actor } from '../tools/rbac.js';

export const NOW = new Date('2026-10-19T08:00:00Z');
export const ANCHOR = new Date('2026-10-19T00:00:00Z');

export function setup() {
  const store = Store.seeded(42, ANCHOR);
  const proposals = new ProposalStore();
  const mock = new MockProvider('anthropic');
  const meter = new Meter(':memory:');
  const router = new Router({
    providers: { anthropic: mock },
    routes: () => [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    meter,
    sleep: async () => {},
    random: () => 0,
  });
  const run = (actor: Actor, text: string, extra: Partial<RunAgentOptions> = {}) =>
    runAgent({
      messages: [{ role: 'user', content: text } satisfies Message],
      actor, router, store, proposals, meter, now: () => NOW, ...extra,
    });
  return { store, proposals, mock, meter, router, run };
}

/** A weekday slot in the future with no booking, found via the store itself. */
export function freeSlot(store: Store, practitionerId = 'p-1'): string {
  const slot = store.freeSlots({ practitionerId, from: new Date('2026-10-26T00:00:00Z'), to: new Date('2026-10-30T00:00:00Z'), after: NOW })[0];
  if (!slot) throw new Error('no free slot');
  return slot.start;
}
