import { SLOT_MIN, WORK_END_HOUR, WORK_START_HOUR } from './types.js';
import type { Appointment, Client, ClientNote, Practitioner, StoreData } from './types.js';

/** mulberry32: tiny deterministic PRNG, good enough for fixture data. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ana', 'Ben', 'Chloe', 'Dev', 'Elena', 'Farid', 'Grace', 'Hugo', 'Iris', 'Jin',
  'Kofi', 'Lena', 'Marco', 'Nia', 'Omar', 'Paula', 'Quinn', 'Rosa', 'Sam', 'Tara'];
const LAST = ['Adler', 'Brandt', 'Castillo', 'Dube', 'Eriksen', 'Fontaine', 'Gupta', 'Haas', 'Ito', 'Jovanovic'];
const REASONS = ['Initial consultation', 'Follow-up', 'Lower back pain', 'Annual check-up', 'Nutrition plan review', 'Sports injury'];
const NOTE_TEXTS = [
  'Prefers morning appointments.',
  'Allergic to latex.',
  'Referred by a family member.',
  'Asked about reminder messages by email.',
  'Responds well to the stretching routine.',
];

const PRACTITIONERS: Practitioner[] = [
  { id: 'p-1', name: 'Dr. Mira Okafor', specialty: 'General practice' },
  { id: 'p-2', name: 'Dr. Jonas Lindqvist', specialty: 'Physiotherapy' },
  { id: 'p-3', name: 'Dr. Priya Raman', specialty: 'Nutrition' },
];

const pad = (n: number, w = 3) => String(n).padStart(w, '0');

/**
 * Builds the fictional Northwind Clinic dataset. Same seed + anchor => identical data.
 * `anchor` should be a UTC midnight; appointments span roughly -20..+20 days around it.
 */
export function generateSeed(seed = 42, anchor = new Date('2026-10-19T00:00:00Z')): StoreData {
  const rng = createRng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

  const clients: Client[] = Array.from({ length: 40 }, (_, i) => {
    const first = FIRST[(i * 7) % FIRST.length] as string;
    const last = LAST[(i * 3 + Math.floor(i / FIRST.length)) % LAST.length] as string;
    return {
      id: `c-${pad(i + 1)}`,
      name: `${first} ${last}`,
      email: `${first}.${last}.${i + 1}@example.test`.toLowerCase(),
      phone: `+1-555-01${pad(i + 1, 2)}`,
    };
  });

  const taken = new Set<string>();
  const appointments: Appointment[] = [];
  const slotsPerDay = ((WORK_END_HOUR - WORK_START_HOUR) * 60) / SLOT_MIN;
  while (appointments.length < 120) {
    const practitioner = pick(PRACTITIONERS);
    const day = new Date(anchor.getTime() + (Math.floor(rng() * 41) - 20) * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const slot = Math.floor(rng() * slotsPerDay);
    const start = new Date(day.getTime() + (WORK_START_HOUR * 60 + slot * SLOT_MIN) * 60_000).toISOString();
    const key = `${practitioner.id}|${start}`;
    if (taken.has(key)) continue;
    taken.add(key);

    const past = day.getTime() < anchor.getTime();
    const roll = rng();
    const status = past
      ? roll < 0.8 ? 'completed' : roll < 0.9 ? 'no_show' : 'cancelled'
      : roll < 0.9 ? 'scheduled' : 'cancelled';
    appointments.push({
      id: `a-${pad(appointments.length + 1)}`,
      clientId: pick(clients).id,
      practitionerId: practitioner.id,
      start,
      durationMin: SLOT_MIN,
      status,
      reason: pick(REASONS),
    });
  }
  appointments.sort((a, b) => a.start.localeCompare(b.start));

  const notes: ClientNote[] = clients.slice(0, 12).map((c, i) => ({
    id: `n-${pad(i + 1)}`,
    clientId: c.id,
    at: new Date(anchor.getTime() - (i + 1) * 86_400_000).toISOString(),
    author: PRACTITIONERS[i % PRACTITIONERS.length]?.name ?? 'staff',
    text: pick(NOTE_TEXTS),
  }));

  return { practitioners: PRACTITIONERS.map((p) => ({ ...p })), clients, appointments, notes };
}
