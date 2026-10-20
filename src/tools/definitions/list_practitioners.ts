import { z } from 'zod';
import { defineTool } from '../define.js';

export const listPractitioners = defineTool({
  name: 'list_practitioners',
  description: 'List the clinic practitioners and their specialties.',
  kind: 'read',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  input: z.object({}),
  handler: async (_args, ctx) => ctx.store.listPractitioners(),
});
