import { z } from 'zod';
import { defineTool } from '../define.js';
import { scopeClientId } from './shared.js';

export const listAppointments = defineTool({
  name: 'list_appointments',
  description: 'List appointments (max 50). Clients only ever see their own.',
  kind: 'read',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  input: z.object({
    clientId: z.string().optional(),
    practitionerId: z.string().optional(),
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional().describe('Exclusive upper bound'),
  }),
  handler: async (args, ctx) => {
    const clientId = ctx.actor.role === 'client' ? scopeClientId(undefined, ctx) : args.clientId;
    return ctx.store.listAppointments({
      clientId,
      practitionerId: args.practitionerId,
      status: args.status,
      from: args.from ? new Date(`${args.from}T00:00:00Z`) : undefined,
      to: args.to ? new Date(`${args.to}T00:00:00Z`) : undefined,
    });
  },
});
