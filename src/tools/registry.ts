import { z } from 'zod';
import type { ToolSpec } from '../providers/types.js';
import { ToolError, type Tool, type ToolContext } from './define.js';
import { canUse, type Actor } from './rbac.js';
import { addClientNote } from './definitions/add_client_note.js';
import { cancelAppointment } from './definitions/cancel_appointment.js';
import { createAppointment } from './definitions/create_appointment.js';
import { createClient } from './definitions/create_client.js';
import { findFreeSlots } from './definitions/find_free_slots.js';
import { getClient } from './definitions/get_client.js';
import { getClientNotes } from './definitions/get_client_notes.js';
import { getClinicStats } from './definitions/get_clinic_stats.js';
import { listAppointments } from './definitions/list_appointments.js';
import { listPractitioners } from './definitions/list_practitioners.js';
import { rescheduleAppointment } from './definitions/reschedule_appointment.js';
import { searchClients } from './definitions/search_clients.js';

export { defineTool } from './define.js';

export const ALL_TOOLS: Tool[] = [
  listPractitioners,
  findFreeSlots,
  searchClients,
  getClient,
  listAppointments,
  getClinicStats,
  getClientNotes,
  createAppointment,
  rescheduleAppointment,
  cancelAppointment,
  createClient,
  addClientNote,
];

export function getTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** RBAC point 1 (exposure): only these tools are ever described to the model. */
export function toolsFor(actor: Actor): Tool[] {
  return ALL_TOOLS.filter((t) => canUse(t, actor));
}

export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => {
    const parameters = z.toJSONSchema(t.input) as Record<string, unknown>;
    delete parameters.$schema;
    return { name: t.name, description: t.description, parameters };
  });
}

/** RBAC point 3 (execution): re-checks everything; never trusts that the proposal was valid when created. */
export async function executeConfirmed(proposal: { tool: string; args: unknown }, ctx: ToolContext): Promise<unknown> {
  const tool = getTool(proposal.tool);
  if (!tool) throw new ToolError('unknown_tool', `Unknown tool ${proposal.tool}`);
  if (tool.kind !== 'write') throw new ToolError('not_a_write_tool', `${tool.name} is not a write tool`);
  if (!canUse(tool, ctx.actor)) throw new ToolError('forbidden', `Actor may not run ${tool.name}`);
  const parsed = tool.input.safeParse(proposal.args);
  if (!parsed.success) throw new ToolError('invalid_args', parsed.error.message);
  return tool.handler(parsed.data, ctx);
}
