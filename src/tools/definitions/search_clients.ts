import { z } from 'zod';
import { defineTool } from '../define.js';

export const searchClients = defineTool({
  name: 'search_clients',
  description: 'Search clients by name, email or phone (substring match, max 10 results).',
  kind: 'read',
  audiences: ['owner', 'practitioner', 'receptionist'],
  permission: { key: 'clients', level: 1 },
  input: z.object({ query: z.string().min(1) }),
  handler: async (args, ctx) => ctx.store.searchClients(args.query),
});
