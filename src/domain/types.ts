export const SLOT_MIN = 30;
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 17;

export interface Practitioner {
  id: string;
  name: string;
  specialty: string;
}

export interface Client {
  id: string;
  name: string;
  email: string;
  phone?: string;
}

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

export interface Appointment {
  id: string;
  clientId: string;
  practitionerId: string;
  /** ISO-8601 UTC, always on the 30-minute grid. */
  start: string;
  durationMin: number;
  status: AppointmentStatus;
  reason: string;
}

export interface ClientNote {
  id: string;
  clientId: string;
  at: string;
  author: string;
  text: string;
}

export interface StoreData {
  practitioners: Practitioner[];
  clients: Client[];
  appointments: Appointment[];
  notes: ClientNote[];
}
