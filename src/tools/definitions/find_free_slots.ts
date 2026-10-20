import { z } from 'zod';
import { defineTool } from '../define.js';
import { ToolError } from '../define.js';

const MAX_RANGE_DAYS = 14;

export const findFreeSlots = defineTool({
  name: 'find_free_slots',
  description: 'Find open 30-minute appointment slots (weekdays 09:00-17:00 UTC) in a date range, optionally for one practitioner.',
  kind: 'read',
  audiences: ['owner', 'practitioner', 'receptionist', 'client'],
  input: z.object({
    practitionerId: z.string().optional(),
    from: z.iso.date().describe('First day, YYYY-MM-DD'),
    to: z.iso.date().describe('Last day, YYYY-MM-DD (max 14 days after from)'),
  }),
  handler: async (args, ctx) => {
    const from = new Date(`${args.from}T00:00:00Z`);
    const to = new Date(`${args.to}T00:00:00Z`);
    if (to < from) throw new ToolError('invalid_args', '"to" must not be before "from"');
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new ToolError('invalid_args', `Range is limited to ${MAX_RANGE_DAYS} days`);
    }
    return ctx.store.freeSlots({ practitionerId: args.practitionerId, from, to, after: ctx.now });
  },
});
