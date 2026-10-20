import { createInterface } from 'node:readline/promises';
import { confirmAndResume, runAgent, type AgentResult } from '../agent/loop.js';
import { ProposalStore } from '../agent/proposals.js';
import { Store } from '../domain/store.js';
import { Meter } from '../metering/meter.js';
import { MockProvider } from '../providers/mock.js';
import { providersFromEnv } from '../providers/index.js';
import type { Message, Provider } from '../providers/types.js';
import { Router } from '../router/router.js';
import { makeActor } from '../tools/rbac.js';

const day = 86_400_000;
const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const date = (offset: number) => new Date(midnight.getTime() + offset * day).toISOString().slice(0, 10);

/** Scripted stand-in for a model, used when no API keys are configured. */
function scriptedProvider(): MockProvider {
  return new MockProvider('anthropic').push(
    { toolCalls: [{ name: 'find_free_slots', args: { practitionerId: 'p-1', from: date(1), to: date(4) } }] },
    (req) => {
      const last = req.messages.at(-1);
      const content = last?.role === 'tool' ? (last.results[0]?.content ?? '') : '';
      const start = /"start":"([^"]+)"/.exec(content)?.[1] ?? `${date(2)}T09:00:00.000Z`;
      return { toolCalls: [{ name: 'create_appointment', args: { clientId: 'c-001', practitionerId: 'p-1', start, reason: 'Follow-up' } }] };
    },
    { text: 'All set: the appointment has been booked.' },
  );
}

async function main() {
  const live = providersFromEnv();
  const scripted = Object.keys(live).length === 0;
  const providers: Record<string, Provider> = scripted ? { anthropic: scriptedProvider() } : live;
  const meter = new Meter();
  const router = new Router({ providers, meter });
  const store = Store.seeded(42, midnight);
  const proposals = new ProposalStore();
  const actor = makeActor('receptionist', 'rec-1');
  const history: Message[] = [];
  const ctx = { actor, router, store, proposals, meter, now: () => new Date() };

  const show = async (result: AgentResult): Promise<void> => {
    if (result.kind === 'text') {
      console.log(`assistant> ${result.text}`);
      history.push({ role: 'assistant', content: result.text });
    } else if (result.kind === 'error') {
      console.log(`error> ${result.reason}`);
    } else {
      console.log(`proposal> ${result.proposal.summary}`);
      const ok = scripted ? true : (await ask(`${result.proposal.confirmLabel}? [y/N] `)).trim().toLowerCase() === 'y';
      if (!ok) return console.log('(declined)');
      const { next } = await confirmAndResume({ ...ctx, messages: history, proposalId: result.proposal.id });
      await show(next);
    }
  };

  const rl = scripted ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => (rl ? rl.question(q) : Promise.resolve(''));
  const turn = async (text: string) => {
    history.push({ role: 'user', content: text });
    await show(await runAgent({ ...ctx, messages: history }));
  };

  if (scripted) {
    console.log('No API keys set: running a scripted conversation with the mock provider.\n');
    const prompt = 'Book client c-001 with practitioner p-1 at the first free slot in the next few days.';
    console.log(`you> ${prompt}`);
    await turn(prompt);
  } else {
    for (;;) {
      const line = (await ask('you> ')).trim();
      if (!line || line === 'exit') break;
      await turn(line);
    }
    rl?.close();
  }
  meter.close();
}

await main();
