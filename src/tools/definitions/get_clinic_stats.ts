import { z } from 'zod';
import { defineTool } from '../define.js';

const DAYS = { last_7_days: -7, last_30_days: -30, next_7_days: 7 } as const;

export const getClinicStats = defineTool({
  name: 'get_clinic_stats',
  description: 'Aggregate appointment counts for a period relative to now.',
  kind: 'read',
  audiences: ['owner', 'practitioner'],
  permission: { key: 'stats', level: 1 },
  input: z.object({ period: z.enum(['last_7_days', 'last_30_days', 'next_7_days']) }),
  handler: async (args, ctx) => {
    const offset = DAYS[args.period] * 86_400_000;
    const other = new Date(ctx.now.getTime() + offset);
    const [from, to] = offset < 0 ? [other, ctx.now] : [ctx.now, other];
    return { period: args.period, ...ctx.store.stats(from, to) };
  },
});
