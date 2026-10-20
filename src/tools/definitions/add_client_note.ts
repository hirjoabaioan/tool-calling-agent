import { z } from 'zod';
import { defineTool } from '../define.js';

export const addClientNote = defineTool({
  name: 'add_client_note',
  description: 'Append a free-text note to a client record. Requires user confirmation.',
  kind: 'write',
  audiences: ['owner', 'practitioner'],
  permission: { key: 'notes', level: 2 },
  input: z.object({ clientId: z.string(), text: z.string().min(1).max(1000) }),
  summarize: (a) => `Add note to ${a.clientId}`,
  confirmLabel: 'Save note',
  handler: async (args, ctx) => ctx.store.addNote({ ...args, author: ctx.actor.id }, ctx.now),
});
