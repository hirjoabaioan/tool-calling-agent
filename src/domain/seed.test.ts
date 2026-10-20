import { describe, expect, it } from 'vitest';
import { createRng, generateSeed } from './seed.js';
import { Store } from './store.js';

describe('seed', () => {
  it('produces the documented sizes', () => {
    const d = generateSeed();
    expect([d.practitioners.length, d.clients.length, d.appointments.length]).toEqual([3, 40, 120]);
  });

  it('is deterministic for the same seed and different otherwise', () => {
    expect(generateSeed(7)).toEqual(generateSeed(7));
    expect(generateSeed(7)).not.toEqual(generateSeed(8));
    const a = createRng(1);
    const b = createRng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('never double-books a practitioner', () => {
    const keys = generateSeed().appointments.map((a) => `${a.practitionerId}|${a.start}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('store', () => {
  const now = new Date('2026-10-19T08:00:00Z');

  it('rejects slots that are taken, off-grid or in the past', () => {
    const store = Store.seeded();
    const taken = store.listAppointments({ status: 'scheduled', from: new Date('2026-10-20T00:00:00Z') })[0];
    if (!taken) throw new Error('fixture');
    const input = { clientId: 'c-001', practitionerId: taken.practitionerId, reason: 'x' };
    expect(() => store.createAppointment({ ...input, start: taken.start }, now)).toThrow(/not available/);
    expect(() => store.createAppointment({ ...input, start: '2026-10-21T09:10:00Z' }, now)).toThrow(/working hours/);
    expect(() => store.createAppointment({ ...input, start: '2026-10-12T09:00:00Z' }, now)).toThrow(/future/);
  });
});
