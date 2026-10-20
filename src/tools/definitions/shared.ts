import type { Appointment } from '../../domain/types.js';
import { ToolError, type ToolContext } from '../define.js';

/**
 * The client id is never trusted from model arguments for the client role:
 * it is always replaced by the authenticated actor's own id.
 */
export function scopeClientId(requested: string | undefined, ctx: ToolContext): string {
  if (ctx.actor.role === 'client') {
    if (!ctx.actor.clientId) throw new ToolError('forbidden', 'Client actor has no clientId');
    return ctx.actor.clientId;
  }
  if (!requested) throw new ToolError('invalid_args', 'clientId is required');
  return requested;
}

/** Clients can only act on their own appointments; others look "not found" rather than forbidden. */
export function requireVisibleAppointment(id: string, ctx: ToolContext): Appointment {
  const appt = ctx.store.getAppointment(id);
  if (!appt || (ctx.actor.role === 'client' && appt.clientId !== ctx.actor.clientId)) {
    throw new ToolError('failed', `Unknown appointment ${id}`);
  }
  return appt;
}
