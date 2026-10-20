import { generateSeed } from './seed.js';
import { SLOT_MIN, WORK_END_HOUR, WORK_START_HOUR } from './types.js';
import type { Appointment, AppointmentStatus, Client, ClientNote, Practitioner, StoreData } from './types.js';

const DAY_MS = 86_400_000;

export class DomainError extends Error {}

export interface AppointmentFilter {
  clientId?: string;
  practitionerId?: string;
  status?: AppointmentStatus;
  from?: Date;
  to?: Date;
}

export class Store {
  private data: StoreData;
  private seq = { appointment: 0, client: 0, note: 0 };

  constructor(data: StoreData) {
    this.data = structuredClone(data);
    this.seq.appointment = data.appointments.length;
    this.seq.client = data.clients.length;
    this.seq.note = data.notes.length;
  }

  static seeded(seed = 42, anchor?: Date): Store {
    return new Store(generateSeed(seed, anchor));
  }

  listPractitioners(): Practitioner[] {
    return this.data.practitioners;
  }

  getClient(id: string): Client | undefined {
    return this.data.clients.find((c) => c.id === id);
  }

  searchClients(query: string, limit = 10): Client[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.data.clients
      .filter((c) => [c.name, c.email, c.phone ?? ''].some((v) => v.toLowerCase().includes(q)))
      .slice(0, limit);
  }

  getAppointment(id: string): Appointment | undefined {
    return this.data.appointments.find((a) => a.id === id);
  }

  listAppointments(f: AppointmentFilter = {}, limit = 50): Appointment[] {
    return this.data.appointments
      .filter(
        (a) =>
          (!f.clientId || a.clientId === f.clientId) &&
          (!f.practitionerId || a.practitionerId === f.practitionerId) &&
          (!f.status || a.status === f.status) &&
          (!f.from || new Date(a.start) >= f.from) &&
          (!f.to || new Date(a.start) < f.to),
      )
      .slice(0, limit);
  }

  /** Open 30-minute weekday slots between two UTC dates (inclusive), strictly after `after`. */
  freeSlots(opts: { practitionerId?: string; from: Date; to: Date; after: Date }, limit = 30) {
    const ids = opts.practitionerId ? [opts.practitionerId] : this.data.practitioners.map((p) => p.id);
    const out: { practitionerId: string; start: string }[] = [];
    for (let t = opts.from.getTime(); t <= opts.to.getTime(); t += DAY_MS) {
      const day = new Date(t);
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      for (let m = WORK_START_HOUR * 60; m < WORK_END_HOUR * 60; m += SLOT_MIN) {
        const start = new Date(t + m * 60_000);
        if (start <= opts.after) continue;
        for (const practitionerId of ids) {
          if (!this.isBusy(practitionerId, start.toISOString())) out.push({ practitionerId, start: start.toISOString() });
        }
      }
    }
    return out.slice(0, limit);
  }

  createAppointment(input: { clientId: string; practitionerId: string; start: string; reason: string }, now: Date): Appointment {
    if (!this.getClient(input.clientId)) throw new DomainError(`Unknown client ${input.clientId}`);
    if (!this.data.practitioners.some((p) => p.id === input.practitionerId)) {
      throw new DomainError(`Unknown practitioner ${input.practitionerId}`);
    }
    const start = this.checkSlot(input.start, now);
    if (this.isBusy(input.practitionerId, start)) throw new DomainError('Slot is not available');
    const appt: Appointment = {
      id: `a-${String(++this.seq.appointment).padStart(3, '0')}`,
      clientId: input.clientId,
      practitionerId: input.practitionerId,
      start,
      durationMin: SLOT_MIN,
      status: 'scheduled',
      reason: input.reason,
    };
    this.data.appointments.push(appt);
    return appt;
  }

  rescheduleAppointment(id: string, newStart: string, now: Date): Appointment {
    const appt = this.requireScheduled(id);
    const start = this.checkSlot(newStart, now);
    if (this.isBusy(appt.practitionerId, start, id)) throw new DomainError('Slot is not available');
    appt.start = start;
    return appt;
  }

  cancelAppointment(id: string): Appointment {
    const appt = this.requireScheduled(id);
    appt.status = 'cancelled';
    return appt;
  }

  createClient(input: { name: string; email: string; phone?: string }): Client {
    const client: Client = { id: `c-${String(++this.seq.client).padStart(3, '0')}`, ...input };
    this.data.clients.push(client);
    return client;
  }

  getNotes(clientId: string): ClientNote[] {
    return this.data.notes.filter((n) => n.clientId === clientId);
  }

  addNote(input: { clientId: string; author: string; text: string }, now: Date): ClientNote {
    if (!this.getClient(input.clientId)) throw new DomainError(`Unknown client ${input.clientId}`);
    const note: ClientNote = { id: `n-${String(++this.seq.note).padStart(3, '0')}`, at: now.toISOString(), ...input };
    this.data.notes.push(note);
    return note;
  }

  stats(from: Date, to: Date) {
    const appts = this.listAppointments({ from, to }, Infinity);
    const byStatus: Record<string, number> = {};
    const byPractitioner: Record<string, number> = {};
    for (const a of appts) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      byPractitioner[a.practitionerId] = (byPractitioner[a.practitionerId] ?? 0) + 1;
    }
    return { total: appts.length, byStatus, byPractitioner, uniqueClients: new Set(appts.map((a) => a.clientId)).size };
  }

  private requireScheduled(id: string): Appointment {
    const appt = this.getAppointment(id);
    if (!appt) throw new DomainError(`Unknown appointment ${id}`);
    if (appt.status !== 'scheduled') throw new DomainError(`Appointment ${id} is ${appt.status}`);
    return appt;
  }

  private isBusy(practitionerId: string, startIso: string, ignoreId?: string): boolean {
    return this.data.appointments.some(
      (a) => a.id !== ignoreId && a.practitionerId === practitionerId && a.start === startIso && a.status !== 'cancelled',
    );
  }

  private checkSlot(startIso: string, now: Date): string {
    const d = new Date(startIso);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const onGrid = d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0 && minutes % SLOT_MIN === 0;
    const open = minutes >= WORK_START_HOUR * 60 && minutes < WORK_END_HOUR * 60;
    const weekday = d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
    if (!onGrid || !open || !weekday) throw new DomainError('Start is outside working hours');
    if (d <= now) throw new DomainError('Start must be in the future');
    return d.toISOString();
  }
}
