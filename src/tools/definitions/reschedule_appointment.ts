import { z } from 'zod';
import { defineTool } from '../define.js';
import { requireVisibleAppointment } from './shared.js';

export const rescheduleAppointment = defineTool({
  name: 'reschedule_appointment',
  description: 'Move a scheduled appointment to a new start time. Requires user confirmation.',
  kind: 'write',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  permission: { key: 'appointments', level: 2 },
  input: z.object({ appointmentId: z.string(), start: z.iso.datetime() }),
  summarize: (a) => `Move ${a.appointmentId} to ${a.start}`,
  confirmLabel: 'Reschedule',
  handler: async (args, ctx) => {
    requireVisibleAppointment(args.appointmentId, ctx);
    return ctx.store.rescheduleAppointment(args.appointmentId, args.start, ctx.now);
  },
});
