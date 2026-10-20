import { describe, expect, it } from 'vitest';
import { Store } from '../domain/store.js';
import { ANCHOR, NOW } from '../testing/helpers.js';
import { makeActor } from '../tools/rbac.js';
import { PROPOSAL_TTL_MS, ProposalStore } from './proposals.js';

const owner = makeActor('owner', 'owner-1');
const args = { name: 'Zed Test', email: 'zed@example.test' };

function ctx(actor = owner, now = NOW) {
  return { actor, store: Store.seeded(42, ANCHOR), now };
}

describe('ProposalStore', () => {
  it('creates a proposal with summary, label and a 10 minute expiry', () => {
    const p = new ProposalStore().create('create_client', args, owner, NOW);
    expect(p.summary).toContain('Zed Test');
    expect(p.confirmLabel).toBe('Create client');
    expect(new Date(p.expiresAt).getTime() - new Date(p.createdAt).getTime()).toBe(PROPOSAL_TTL_MS);
    expect(PROPOSAL_TTL_MS).toBe(600_000);
  });

  it('is bound to the actor: another actor cannot see or confirm it', async () => {
    const store = new ProposalStore();
    const p = store.create('create_client', args, owner, NOW);
    const intruder = makeActor('owner', 'owner-2');
    expect(store.get(p.id, intruder)).toBeUndefined();
    await expect(store.confirm(p.id, ctx(intruder))).rejects.toMatchObject({ code: 'not_found' });
    expect(store.get(p.id, owner)).toBeDefined();
  });

  it('expires after the TTL', async () => {
    const store = new ProposalStore();
    const p = store.create('create_client', args, owner, NOW);
    const late = new Date(NOW.getTime() + PROPOSAL_TTL_MS);
    await expect(store.confirm(p.id, ctx(owner, late))).rejects.toMatchObject({ code: 'expired' });
  });

  it('still confirms just before expiry, and only once', async () => {
    const store = new ProposalStore();
    const p = store.create('create_client', args, owner, NOW);
    const c = ctx(owner, new Date(NOW.getTime() + PROPOSAL_TTL_MS - 1));
    const { result } = await store.confirm(p.id, c);
    expect(c.store.getClient((result as { id: string }).id)?.email).toBe('zed@example.test');
    await expect(store.confirm(p.id, c)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('re-validates args with Zod at confirm time', async () => {
    const store = new ProposalStore();
    const p = store.create('create_client', { name: 'Zed', email: 'broken' }, owner, NOW);
    await expect(store.confirm(p.id, ctx())).rejects.toMatchObject({ code: 'invalid_args' });
  });

  it('re-checks RBAC at confirm time if the actor lost permission', async () => {
    const store = new ProposalStore();
    const rec = makeActor('receptionist', 'r');
    const p = store.create('create_client', args, rec, NOW);
    const demoted = { ...rec, permissions: { clients: 0 } };
    await expect(store.confirm(p.id, ctx(demoted))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
