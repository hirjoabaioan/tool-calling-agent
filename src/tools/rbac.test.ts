import { describe, expect, it } from 'vitest';
import { setup } from '../testing/helpers.js';
import { ToolError } from './define.js';
import { canUse, makeActor } from './rbac.js';
import { ALL_TOOLS, executeConfirmed, getTool, toolsFor } from './registry.js';

const names = (role: Parameters<typeof makeActor>[0]) => toolsFor(makeActor(role, 'x', 'c-001')).map((t) => t.name);

describe('registry', () => {
  it('defines 12 tools: 7 read and 5 write', () => {
    expect(ALL_TOOLS).toHaveLength(12);
    expect(ALL_TOOLS.filter((t) => t.kind === 'write')).toHaveLength(5);
  });
});

describe('RBAC point 1: exposure', () => {
  it('hides stats and notes from the receptionist', () => {
    const n = names('receptionist');
    expect(n).not.toContain('get_clinic_stats');
    expect(n).not.toContain('get_client_notes');
    expect(n).toContain('create_appointment');
    expect(n).toContain('reschedule_appointment');
  });

  it('hides cancel from the receptionist (needs appointments level 3) but not from a promoted one', () => {
    expect(names('receptionist')).not.toContain('cancel_appointment');
    expect(toolsFor(makeActor('receptionist', 'r', undefined, { appointments: 3 })).map((t) => t.name)).toContain('cancel_appointment');
  });

  it('gives clients no staff-only tools', () => {
    const n = names('client');
    for (const hidden of ['search_clients', 'get_client_notes', 'get_clinic_stats', 'create_client', 'add_client_note']) {
      expect(n).not.toContain(hidden);
    }
  });

  it('requires ALL permissions when an array is given', () => {
    const guarded = { audiences: ['owner' as const], permission: [{ key: 'a', level: 2 as const }, { key: 'b', level: 3 as const }] };
    expect(canUse(guarded, { id: 'o', role: 'owner', permissions: { a: 4, b: 2 } })).toBe(false);
    expect(canUse(guarded, { id: 'o', role: 'owner', permissions: { a: 4, b: 3 } })).toBe(true);
  });
});

describe('RBAC point 2: loop refusal', () => {
  it('refuses a tool the actor was never shown, reports it to the model and meters it', async () => {
    const { mock, run, meter } = setup();
    mock.push({ toolCalls: [{ name: 'get_clinic_stats', args: { period: 'last_7_days' } }] }, { text: 'Sorry, I cannot do that.' });
    const result = await run(makeActor('receptionist', 'r1'), 'Show me stats');
    expect(result.kind).toBe('text');
    const secondRequest = mock.calls[1]?.messages.at(-1);
    expect(JSON.stringify(secondRequest)).toContain('not available');
    const refused = meter.rows().filter((r) => r.error_kind === 'tool_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.model).toBe('get_clinic_stats');
  });

  it('does not describe hidden tools to the model', async () => {
    const { mock, run } = setup();
    mock.push({ text: 'hi' });
    await run(makeActor('client', 'u1', 'c-001'), 'hello');
    const sent = mock.calls[0]?.tools.map((t) => t.name) ?? [];
    expect(sent).not.toContain('get_client_notes');
    expect(sent).toContain('list_appointments');
  });
});

describe('RBAC point 3: execution', () => {
  const ctxFor = (actor: ReturnType<typeof makeActor>) => ({ actor, store: setup().store, now: new Date('2026-10-19T08:00:00Z') });

  it('rejects an audience the tool does not allow', async () => {
    const p = { tool: 'add_client_note', args: { clientId: 'c-001', text: 'hi' } };
    await expect(executeConfirmed(p, ctxFor(makeActor('client', 'u', 'c-001')))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects insufficient permission level', async () => {
    const p = { tool: 'cancel_appointment', args: { appointmentId: 'a-001' } };
    await expect(executeConfirmed(p, ctxFor(makeActor('receptionist', 'r')))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses read tools and unknown tools', async () => {
    const ctx = ctxFor(makeActor('owner', 'o'));
    await expect(executeConfirmed({ tool: 'list_practitioners', args: {} }, ctx)).rejects.toMatchObject({ code: 'not_a_write_tool' });
    await expect(executeConfirmed({ tool: 'nope', args: {} }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it('re-validates args with Zod', async () => {
    const ctx = ctxFor(makeActor('owner', 'o'));
    await expect(executeConfirmed({ tool: 'create_client', args: { name: 'A', email: 'not-an-email' } }, ctx)).rejects.toMatchObject({
      code: 'invalid_args',
    });
  });

  it('executes a valid confirmed write', async () => {
    const ctx = ctxFor(makeActor('receptionist', 'r'));
    const created = (await executeConfirmed({ tool: 'create_client', args: { name: 'Zed Test', email: 'zed@example.test' } }, ctx)) as { id: string };
    expect(ctx.store.getClient(created.id)?.name).toBe('Zed Test');
    expect(getTool('create_client')?.kind).toBe('write');
  });
});
