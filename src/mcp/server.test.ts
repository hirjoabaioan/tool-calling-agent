import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { ProposalStore } from '../agent/proposals.js';
import { Store } from '../domain/store.js';
import { Meter } from '../metering/meter.js';
import { makeActor, type Role } from '../tools/rbac.js';
import { ANCHOR, NOW, freeSlot } from '../testing/helpers.js';
import { RateLimiter } from './rate-limit.js';
import { createHttpServer, createMcpServer, type McpDeps } from './server.js';
import { sha256Hex, type TokenMap } from './tokens.js';

function deps(allowWrites = false): McpDeps & { meter: Meter } {
  return { store: Store.seeded(42, ANCHOR), proposals: new ProposalStore(), meter: new Meter(':memory:'), allowWrites, now: () => NOW };
}

async function connect(role: Role, d: McpDeps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(makeActor(role, `${role}-1`, role === 'client' ? 'c-001' : undefined), d).connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe('mcp over an in-memory transport', () => {
  it('lists and calls a read tool, and audits the call', async () => {
    const d = deps();
    const client = await connect('receptionist', d);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('search_clients');
    const res = await client.callTool({ name: 'list_practitioners', arguments: {} });
    expect(JSON.parse(text(res))).toHaveLength(3);
    const rows = d.meter.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'mcp', model: 'list_practitioners', success: 1 });
  });

  it('hides write tools and confirm_proposal by default', async () => {
    const client = await connect('owner', deps(false));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_client_notes');
    expect(names).not.toContain('cancel_appointment');
    expect(names).not.toContain('create_client');
    expect(names).not.toContain('confirm_proposal');
  });

  it('with writes enabled, writes only propose until confirm_proposal runs', async () => {
    const d = deps(true);
    const client = await connect('receptionist', d);
    const start = freeSlot(d.store);
    const before = d.store.listAppointments({}, Infinity).length;
    const res = await client.callTool({ name: 'create_appointment', arguments: { clientId: 'c-001', practitionerId: 'p-1', start, reason: 'Follow-up' } });
    const { proposal } = JSON.parse(text(res));
    expect(d.store.listAppointments({}, Infinity)).toHaveLength(before);
    const done = await client.callTool({ name: 'confirm_proposal', arguments: { proposalId: proposal.id } });
    expect(done.isError).toBeFalsy();
    expect(d.store.listAppointments({}, Infinity)).toHaveLength(before + 1);
    const again = await client.callTool({ name: 'confirm_proposal', arguments: { proposalId: proposal.id } });
    expect(again.isError).toBe(true);
  });

  it('does not let one actor confirm another actor\'s proposal', async () => {
    const d = deps(true);
    const a = await connect('receptionist', d);
    const res = await a.callTool({ name: 'create_client', arguments: { name: 'Zed Test', email: 'zed@example.test' } });
    const { proposal } = JSON.parse(text(res));
    const [x, y] = InMemoryTransport.createLinkedPair();
    await createMcpServer(makeActor('receptionist', 'other-rec'), d).connect(x);
    const other = new Client({ name: 'test', version: '0.0.0' });
    await other.connect(y);
    const stolen = await other.callTool({ name: 'confirm_proposal', arguments: { proposalId: proposal.id } });
    expect(stolen.isError).toBe(true);
  });

  it('records failed calls as failures in the audit log', async () => {
    const d = deps();
    const client = await connect('receptionist', d);
    const res = await client.callTool({ name: 'find_free_slots', arguments: { from: '2026-10-26', to: '2026-12-30' } });
    expect(res.isError).toBe(true);
    expect(d.meter.rows()[0]).toMatchObject({ purpose: 'mcp', success: 0, error_kind: 'tool_error' });
  });
});

describe('rate limiter', () => {
  it('allows a burst, refuses, then refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 2, now: () => t });
    expect(rl.take('k')).toBe(0);
    expect(rl.take('k')).toBe(0);
    expect(rl.take('k')).toBeGreaterThan(0);
    expect(rl.take('other')).toBe(0);
    t = 30_000;
    expect(rl.take('k')).toBe(0);
  });
});

describe('mcp over http', () => {
  const servers: HttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  const TOKENS: TokenMap = {
    [sha256Hex('recep-token')]: { actorId: 'rec-1', role: 'receptionist', audience: 'northwind-mcp' },
    [sha256Hex('owner-token')]: { actorId: 'own-1', role: 'owner', audience: 'northwind-mcp' },
    [sha256Hex('foreign-token')]: { actorId: 'rec-2', role: 'receptionist', audience: 'some-other-server' },
  };

  async function start(extra: { rateLimitPerMin?: number; allowWrites?: boolean } = {}) {
    const d = deps(extra.allowWrites ?? false);
    const server = createHttpServer({ ...d, tokens: TOKENS, host: '127.0.0.1', rateLimitPerMin: extra.rateLimitPerMin });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, d };
  }

  const rpc = (url: string, token: string | undefined, body: unknown) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

  it('rejects a missing token with 401 and a resource_metadata challenge', async () => {
    const { url } = await start();
    const res = await rpc(url, undefined, call('list_practitioners'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  });

  it('rejects an unknown token and a token minted for another audience', async () => {
    const { url } = await start();
    const unknown = await rpc(url, 'nope', call('list_practitioners'));
    expect(unknown.status).toBe(401);
    const foreign = await rpc(url, 'foreign-token', call('list_practitioners'));
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('serves the protected-resource metadata', async () => {
    const { url } = await start();
    const meta = await (await fetch(`${url}/.well-known/oauth-protected-resource`)).json();
    expect(meta).toMatchObject({ resource: `${url}/mcp`, bearer_methods_supported: ['header'] });
  });

  it('answers 403 when the role may not use an existing tool', async () => {
    const { url } = await start();
    const res = await rpc(url, 'recep-token', call('get_clinic_stats'));
    expect(res.status).toBe(403);
  });

  it('answers 403 for a write tool a role lacks permission for, but not when writes are off', async () => {
    const on = await start({ allowWrites: true });
    expect((await rpc(on.url, 'recep-token', call('cancel_appointment'))).status).toBe(403);
    const off = await start({ allowWrites: false });
    expect((await rpc(off.url, 'owner-token', call('cancel_appointment'))).status).not.toBe(403);
  });

  it('rate limits per token with 429 and Retry-After', async () => {
    const { url } = await start({ rateLimitPerMin: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await rpc(url, 'recep-token', call('list_practitioners'))).status);
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses[2]).toBe(429);
    expect((await rpc(url, 'owner-token', call('list_practitioners'))).status).not.toBe(429);
  });

  it('completes a real client round trip with a valid token and hides writes', async () => {
    const { url } = await start();
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer owner-token' } },
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_clinic_stats');
    expect(names).not.toContain('create_appointment');
    const res = await client.callTool({ name: 'list_practitioners', arguments: {} });
    expect(JSON.parse(text(res))).toHaveLength(3);
    await client.close();
  });
});
