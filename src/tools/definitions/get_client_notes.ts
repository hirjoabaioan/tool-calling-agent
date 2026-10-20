import { z } from 'zod';
import { defineTool } from '../define.js';

export const getClientNotes = defineTool({
  name: 'get_client_notes',
  description: 'Read the free-text notes recorded for a client.',
  kind: 'read',
  audiences: ['owner', 'practitioner'],
  permission: { key: 'notes', level: 1 },
  input: z.object({ clientId: z.string() }),
  handler: async (args, ctx) => ctx.store.getNotes(args.clientId),
});
