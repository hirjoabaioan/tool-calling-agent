import { z } from 'zod';
import { defineTool } from '../define.js';
import { scopeClientId } from './shared.js';

export const getClient = defineTool({
  name: 'get_client',
  description: 'Get a client record by id. Clients always receive their own record.',
  kind: 'read',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  input: z.object({ id: z.string().optional() }),
  handler: async (args, ctx) => {
    const id = scopeClientId(args.id, ctx);
    return ctx.store.getClient(id) ?? { error: `Unknown client ${id}` };
  },
});
