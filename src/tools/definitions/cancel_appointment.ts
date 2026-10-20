import { z } from 'zod';
import { defineTool } from '../define.js';
import { requireVisibleAppointment } from './shared.js';

export const cancelAppointment = defineTool({
  name: 'cancel_appointment',
  description: 'Cancel a scheduled appointment. Requires user confirmation.',
  kind: 'write',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  permission: { key: 'appointments', level: 3 },
  input: z.object({ appointmentId: z.string() }),
  summarize: (a) => `Cancel ${a.appointmentId}`,
  confirmLabel: 'Cancel appointment',
  prepare: (args, ctx) => {
    requireVisibleAppointment(args.appointmentId, ctx);
    return args;
  },
  handler: async (args, ctx) => {
    requireVisibleAppointment(args.appointmentId, ctx);
    return ctx.store.cancelAppointment(args.appointmentId);
  },
});
