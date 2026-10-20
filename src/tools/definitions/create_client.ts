import { z } from 'zod';
import { defineTool } from '../define.js';

export const createClient = defineTool({
  name: 'create_client',
  description: 'Register a new client. Requires user confirmation.',
  kind: 'write',
  audiences: ['owner', 'practitioner', 'receptionist'],
  permission: { key: 'clients', level: 2 },
  input: z.object({ name: z.string().min(1).max(100), email: z.email(), phone: z.string().max(30).optional() }),
  summarize: (a) => `Create client ${a.name} <${a.email}>`,
  confirmLabel: 'Create client',
  handler: async (args, ctx) => ctx.store.createClient(args),
});
