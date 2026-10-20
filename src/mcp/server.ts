// SDK choice: the official typescript-sdk README (main branch) now points to the split v2 packages
// (@modelcontextprotocol/server, /client, /node) as the stable line; the monolithic
// @modelcontextprotocol/sdk is the v1.x maintenance branch. So this project uses v2.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { ProposalError, ProposalStore } from '../agent/proposals.js';
import { Store } from '../domain/store.js';
import { Meter, type MeterSink } from '../metering/meter.js';
import { ToolError, type ToolContext } from '../tools/define.js';
import { makeActor, type Actor } from '../tools/rbac.js';
import { getTool, toolsFor } from '../tools/registry.js';
import { RateLimiter } from './rate-limit.js';
import { parseTokens, sha256Hex, type TokenMap } from './tokens.js';

export const DEFAULT_SERVER_ID = 'northwind-mcp';
export const CONFIRM_TOOL = 'confirm_proposal';

export interface McpDeps {
  store: Store;
  proposals: ProposalStore;
  meter?: MeterSink;
  allowWrites: boolean;
  now?: () => Date;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });

/** Builds one server whose tool list is fixed by the actor's RBAC and the writes switch. */
export function createMcpServer(actor: Actor, deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'northwind-clinic', version: '0.1.0' });
  const now = deps.now ?? (() => new Date());

  // Every call is audited into the meter, including the ones that fail.
  const audited = (name: string, run: () => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    const started = Date.now();
    let result: ToolResult;
    try {
      result = await run();
    } catch (e) {
      result = fail(e instanceof Error ? e.message : String(e));
    }
    deps.meter?.record({
      runId: randomUUID(), purpose: 'mcp', provider: 'mcp', model: name, attempt: 1,
      success: !result.isError, errorKind: result.isError ? 'tool_error' : undefined, fallback: false,
      durationMs: Date.now() - started, tokensIn: 0, tokensOut: 0, costUsd: null, step: 1,
    });
    return result;
  };

  for (const tool of toolsFor(actor)) {
    if (tool.kind === 'write' && !deps.allowWrites) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.kind === 'write' ? `${tool.description} Returns a proposal; call ${CONFIRM_TOOL} to execute it.` : tool.description,
        inputSchema: tool.input as z.ZodObject,
      },
      async (args: unknown) =>
        audited(tool.name, async () => {
          const parsed = tool.input.safeParse(args);
          if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`);
          const ctx: ToolContext = { actor, store: deps.store, now: now() };
          if (tool.kind === 'write') {
            return ok({ proposal: deps.proposals.create(tool.name, parsed.data as Record<string, unknown>, actor, ctx.now) });
          }
          return ok(await tool.handler(parsed.data, ctx));
        })(),
    );
  }

  const canWrite = deps.allowWrites && toolsFor(actor).some((t) => t.kind === 'write');
  if (canWrite) {
    server.registerTool(
      CONFIRM_TOOL,
      {
        description: 'Execute a previously returned proposal. The actor, permissions and arguments are re-checked at execution.',
        inputSchema: z.object({ proposalId: z.string() }),
      },
      async ({ proposalId }: { proposalId: string }) =>
        audited(CONFIRM_TOOL, async () => {
          try {
            const ctx: ToolContext = { actor, store: deps.store, now: now() };
            const { proposal, result } = await deps.proposals.confirm(proposalId, ctx);
            return ok({ confirmed: proposal.summary, result });
          } catch (e) {
            if (e instanceof ProposalError || e instanceof ToolError) return fail(e.message);
            throw e;
          }
        })(),
    );
  }
  return server;
}

export interface HttpOptions extends McpDeps {
  tokens: TokenMap;
  serverId?: string;
  host?: string;
  /** Requests per minute per token. */
  rateLimitPerMin?: number;
  rateNow?: () => number;
  /** Public URL of the /mcp endpoint, advertised in WWW-Authenticate and the metadata document. */
  publicUrl?: string;
}

const MCP_PATH = '/mcp';
const METADATA_PATH = '/.well-known/oauth-protected-resource';

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Names of tools/call requests in a (possibly batched) JSON-RPC body. */
function calledTools(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.flatMap((m) => {
    const msg = m as { method?: string; params?: { name?: unknown } };
    return msg?.method === 'tools/call' && typeof msg.params?.name === 'string' ? [msg.params.name] : [];
  });
}

export function createHttpServer(opts: HttpOptions): HttpServer {
  const serverId = opts.serverId ?? DEFAULT_SERVER_ID;
  const host = opts.host ?? '127.0.0.1';
  const limiter = new RateLimiter({ perMinute: opts.rateLimitPerMin ?? 30, now: opts.rateNow });
  const validateHost = localhostHostValidation();

  // Behind a proxy set publicUrl; otherwise the (host-validated) Host header is authoritative.
  const baseUrlOf = (req: IncomingMessage) => (opts.publicUrl ?? `http://${req.headers.host ?? `${host}:8787`}${MCP_PATH}`).replace(/\/mcp$/, '');

  const unauthorized = (req: IncomingMessage, res: ServerResponse, error?: string) =>
    json(res, 401, { error: error ?? 'unauthorized' }, {
      'www-authenticate': `Bearer${error ? ` error="${error}",` : ''} resource_metadata="${baseUrlOf(req)}${METADATA_PATH}"`,
    });

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      if (path === METADATA_PATH && req.method === 'GET') {
        // Minimal RFC 9728 document. No authorization_servers: static tokens are a demo shortcut.
        return json(res, 200, { resource: `${baseUrlOf(req)}${MCP_PATH}`, bearer_methods_supported: ['header'], resource_name: serverId });
      }
      if (path !== MCP_PATH) return json(res, 404, { error: 'not_found' });
      if (host === '127.0.0.1' && !validateHost(req, res)) return;
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!bearer) return unauthorized(req, res);
      const hash = sha256Hex(bearer.trim());
      const info = opts.tokens[hash];
      if (!info) return unauthorized(req, res, 'invalid_token');
      if (info.audience !== serverId) return unauthorized(req, res, 'invalid_token');

      const wait = limiter.take(hash);
      if (wait > 0) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(wait) });

      const actor = makeActor(info.role, info.actorId, info.clientId);
      const body = await readJson(req);

      // A tool that exists but this role may not use is a 403, distinct from "no such tool".
      const exposed = new Set(toolsFor(actor).map((t) => t.name));
      for (const name of calledTools(body)) {
        const known = getTool(name);
        const visibleToAnyone = known && (known.kind === 'read' || opts.allowWrites);
        if (visibleToAnyone && !exposed.has(name)) {
          return json(res, 403, { error: 'forbidden', message: `Role ${actor.role} may not use ${name}` });
        }
      }

      // Stateless: a fresh server and transport per request, so actor identity can never leak between callers.
      const server = createMcpServer(actor, opts);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: 'bad_request', message: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });
}

async function main(): Promise<void> {
  const env = process.env;
  const meter = new Meter();
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const deps: McpDeps = {
    store: Store.seeded(42, midnight),
    proposals: new ProposalStore(),
    meter,
    allowWrites: env.MCP_ALLOW_WRITES === '1',
  };

  if (process.argv.includes('--http')) {
    const tokens = parseTokens(env.MCP_TOKENS);
    if (Object.keys(tokens).length === 0) console.error('MCP_TOKENS is empty: every request will get 401.');
    const server = createHttpServer({
      ...deps, tokens,
      serverId: env.MCP_SERVER_ID || DEFAULT_SERVER_ID,
      rateLimitPerMin: Number(env.MCP_RATE_LIMIT_PER_MIN) || 30,
      publicUrl: env.MCP_PUBLIC_URL,
    });
    const port = Number(env.MCP_PORT) || 8787;
    server.listen(port, '127.0.0.1', () => console.error(`MCP listening on http://127.0.0.1:${port}/mcp`));
    return;
  }

  // stdio is a local, already-trusted channel: the role comes from the environment (least privilege by default).
  const role = (env.MCP_ACTOR_ROLE ?? 'receptionist') as Actor['role'];
  const actor = makeActor(role, env.MCP_ACTOR_ID ?? 'stdio-user', env.MCP_CLIENT_ID);
  await createMcpServer(actor, deps).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

