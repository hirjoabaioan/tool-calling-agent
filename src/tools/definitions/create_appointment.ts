import { z } from 'zod';
import { defineTool } from '../define.js';
import { scopeClientId } from './shared.js';

export const createAppointment = defineTool({
  name: 'create_appointment',
  description: 'Book an appointment for a client. Requires user confirmation. Clients always book for themselves.',
  kind: 'write',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  permission: { key: 'appointments', level: 2 },
  input: z.object({
    clientId: z.string().optional(),
    practitionerId: z.string(),
    start: z.iso.datetime().describe('ISO-8601 UTC start on the 30-minute grid'),
    reason: z.string().max(200).default('Consultation'),
  }),
  summarize: (a) => `Book ${a.start} with ${a.practitionerId}${a.clientId ? ` for ${a.clientId}` : ''} (${a.reason})`,
  confirmLabel: 'Book appointment',
  // The proposal must show the client the booking is really for, not whatever id the model guessed.
  prepare: (args, ctx) => ({ ...args, clientId: scopeClientId(args.clientId, ctx) }),
  handler: async (args, ctx) => {
    const clientId = scopeClientId(args.clientId, ctx);
    return ctx.store.createAppointment({ ...args, clientId }, ctx.now);
  },
});
