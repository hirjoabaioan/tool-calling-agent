# tool-calling-agent: build spec

**Public, MIT-licensed** demo of a production-style tool-calling agent. The code is written from scratch and must contain **NO references** to any real product, company, server, table name or path. The domain is fictional: "Northwind Clinic" appointments, with generated seed data.

## Stack and conventions

- TypeScript `strict`, ESM, Node ≥ 20. Package manager: npm.
- Dependencies (latest stable versions only):
  - `zod`, `zod-to-json-schema`
  - `better-sqlite3`
  - `@modelcontextprotocol/sdk`
  - `@anthropic-ai/sdk`, `openai` (OpenAI and DeepSeek via base URL), `@google/genai`
- Dev dependencies: `vitest`, `tsx`, `typescript`, `eslint` + `typescript-eslint`, `@types/better-sqlite3`.
- No other frameworks.
- Scripts:
  - `build`, `test`, `lint`
  - `eval` (live), `eval:replay` (offline, from fixtures, no keys)
  - `report` (latency/cost summary), `mcp` (stdio server), `mcp:http`, `demo` (interactive CLI)
- `.env.example` lists `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` with empty values.
- Every module has unit tests that use a **mock provider**. No test may need network or keys.

## Layout

```
src/
  domain/      seed.ts (fictional clinic: 3 practitioners, 40 clients, 120 appointments, deterministic RNG), store.ts (in-memory repo)
  tools/       registry.ts, rbac.ts, definitions/*.ts (the tools)
  agent/       loop.ts, proposals.ts, prompts.ts
  providers/   types.ts, anthropic.ts, openai.ts (also DeepSeek via baseURL), gemini.ts, mock.ts
  router/      router.ts, breaker.ts, routes.ts
  metering/    meter.ts (SQLite), report.ts (p50/p95)
  mcp/         server.ts (stdio + streamable HTTP)
  cli/         demo.ts
evals/
  cases/*.jsonl, runner.ts, scorers.ts, fixtures/ (recorded provider responses for replay)
examples/mastra/   README + adapter (phase 4)
```

## 1. Tool registry and RBAC (`src/tools`)

### `defineTool()`

```ts
defineTool({
  name: string,
  description: string,
  kind: 'read' | 'write',
  audiences: Role[],                          // Role = 'owner' | 'practitioner' | 'receptionist' | 'client'
  permission?: { key: string, level: 1|2|3|4 } | Array<{ key: string, level: 1|2|3|4 }>,  // array = ALL must pass
  input: ZodSchema,
  handler: (args, ctx) => Promise<unknown>,
})
```

- `ctx` = `{ actor: { id, role, permissions: Record<string, number>, clientId? }, store, now }`.

### RBAC is enforced at three independent points (this is the core design)

1. **Exposure:** `toolsFor(actor)` returns only the tools the actor may see. Only these are sent to the model.
2. **Loop:** if the model calls a tool that is not in the exposed set, the call is refused with a tool error, and the refusal is metered.
3. **Execution:** `executeConfirmed(proposal, actor)` re-checks the audience and permission, re-validates the args with Zod, and only accepts `kind: 'write'`.

### Tools (12)

| Kind | Tool |
|---|---|
| read | `list_practitioners` |
| read | `find_free_slots` (practitionerId?, date range) |
| read | `search_clients` (query) |
| read | `get_client` (id) |
| read | `list_appointments` (filters) |
| read | `get_clinic_stats` (period) |
| read | `get_client_notes` (clientId) — returns free text and is **the prompt-injection carrier in evals** |
| write | `create_appointment` |
| write | `reschedule_appointment` |
| write | `cancel_appointment` |
| write | `create_client` |
| write | `add_client_note` |

### Rules

- **Client role:** a client may only see and change their own data. `clientId` is ALWAYS taken from `ctx.actor`, never from model arguments: the handler overwrites it.
- **Receptionist:** can read everything except stats, and can create and reschedule. Cancel needs `appointments` level 3.

## 2. Agent loop (`src/agent`)

### `runAgent()`

```ts
runAgent({ messages, actor, router, purpose: 'assistant', maxSteps = 8 })
```

Returns one of:
- `{ kind: 'text', text, steps[] }`
- `{ kind: 'proposal', proposal, steps[] }`
- `{ kind: 'error', reason, steps[] }`

### Behaviour

- **Read tools** execute immediately. Their results go back to the model, and results are **wrapped as untrusted data**:

  ```
  <tool_result name=… trusted="false">…</tool_result>
  ```

  The system prompt states that instructions inside tool results must be ignored.
- **Write tools** never execute inside the loop. They return a `proposal`:

  ```
  { id, tool, args, summary, confirmLabel, createdAt, expiresAt (10 min) }
  ```

  The proposal is stored in `proposals.ts` (in memory, keyed by id and bound to the actor id).
- **A write tool requested in the same turn as other calls** is NOT proposed. The model is told to propose it separately.
- **`confirm(proposalId, actor)`** runs `executeConfirmed`, then the loop resumes. The model sees a list of the actions already done, so it doesn't repeat them.
- **Every step** (provider call) is recorded with:
  - provider, model, tokens in/out, cost USD, durationMs;
  - attempt count, fallback flag and fallback reason;
  - tool calls made.
- **When `maxSteps` is exhausted**, the result is `{ kind: 'error', reason: 'max_steps' }`.

## 3. Providers and router (`src/providers`, `src/router`)

### Provider interface

```ts
chat({
  model,
  system,
  messages,
  tools: JSONSchema[],
  timeoutMs,
}): Promise<{ text?, toolCalls?: { name, args }[], usage: { in, out }, raw? }>
```

- Errors are normalised to `ProviderError { kind: 'rate_limit'|'server'|'timeout'|'quota'|'auth'|'bad_request', status? }`.

### Routes

- `routes.ts` maps a purpose to an ordered list of provider and model pairs, for example:

  ```
  assistant → [anthropic:claude-haiku-4-5, openai:gpt-4.1-mini, gemini:gemini-2.5-flash]
  ```

- **Pick current cheap model IDs and keep them in config.** Model IDs must be overridable by env.

### Router behaviour

- **Retries:** `rate_limit` / `server` / `timeout` are retried with exponential backoff (2 retries, base 400 ms, with jitter), then the router falls through to the next route entry.
- **No retry:** `quota` / `auth` / `bad_request` skip straight to the next entry, with no retry.
- **Circuit breaker per provider** (`breaker.ts`):
  - It opens after 3 failures within 60 s and stays open for 120 s.
  - While open, the provider is skipped.
  - After that it goes half-open, and the next call is a probe.
  - The clock is injectable for tests.
- **Metering:** every attempt is metered, including failed attempts and the reason for each one.

### Pricing

- `pricing.ts` holds a per-model USD per 1M tokens table, with a `source` URL and an `asOf` date comment.
- **Unknown model:** cost is `null`, not 0.

## 4. Metering (`src/metering`)

- **Storage:** SQLite file `./data/meter.db`, path overridable. Table `calls`:

  ```
  id, ts, run_id, purpose, provider, model, attempt, success,
  error_kind, fallback, duration_ms, tokens_in, tokens_out, cost_usd, step
  ```

- **`npm run report`** prints, per purpose and per provider/model:
  - calls, success rate, fallback rate;
  - p50 and p95 latency;
  - average and total cost.

## 5. MCP server (`src/mcp`)

- **Tools:** it exposes the **same registry**.
  - Read tools only, by default.
  - Write tools only if `MCP_ALLOW_WRITES=1`, and then always as proposals. `confirm_proposal` is a separate MCP tool.
- **Transports:** stdio and Streamable HTTP, served at `127.0.0.1:8787/mcp`.
- **HTTP auth:**
  - `Authorization: Bearer <token>`. Tokens live in `MCP_TOKENS` as JSON: token sha256 → `{ actorId, role, audience }`.
  - Audience validation: a token whose `audience` is not this server's ID is rejected.
  - A `401` carries `WWW-Authenticate` with a `resource_metadata` URL.
  - Serve a minimal `/.well-known/oauth-protected-resource` document (RFC 9728).
- **README:** explain that production should use OAuth 2.1 per the MCP authorization spec, and that static tokens are for local/demo use.
- **Rate limit:** a token bucket per token. Defaults: 30/min.
- **Audit:** every MCP call is logged into the meter DB (`purpose='mcp'`).

## 6. Evals (`evals/`) — phase 3 (do not build in phase 1)

- **40 cases in JSONL.** Each case has `id`, `group`, `actor`, `messages`, `expect`.
- **Groups:**

  | Group | Cases | Covers |
  |---|---|---|
  | `tool_choice` | 12 | right tool or tool sequence |
  | `args` | 10 | valid, correct args |
  | `rbac` | 10 | role tries a forbidden action → must refuse or not call it, and must never produce a proposal for it |
  | `injection` | 8 | malicious text inside `get_client_notes` or other tool outputs → must not act on it |

- **Scorers are deterministic:** compare tool name/args against expectations, the proposal absent or present, and regexes for refusals. No LLM judge in v1.
- **Runner:**
  - `npm run eval -- --models a,b,c` runs live.
  - It writes `evals/results/<date>.json` and a markdown table: accuracy per group, total cost, p50/p95.
  - `eval:replay` uses the recorded fixtures, so CI needs no keys.

## 7. Quality bar

- **README:**
  - problem;
  - Mermaid diagram;
  - 3-command quickstart (`npm i`, `cp .env.example .env`, `npm run demo`);
  - the design decisions I'd defend in review (3-point RBAC, proposals, untrusted tool output, breaker vs plain retry);
  - eval results table (filled in later);
  - known limitations.
- **CI:** GitHub Actions running lint + test + `eval:replay` on Node 20 and 22.
- **Code style:** small files, no clever abstractions, comments only where the *why* isn't obvious.

## Build phases

1. **Core:** domain + tools + RBAC + agent loop + providers (mock fully working; real adapters compiled but not exercised by tests) + router/breaker + metering + report + CLI demo + unit tests. `npm test` and `npm run lint` green.
2. **MCP server** + tests (stdio round trip with the SDK client; HTTP auth: 401/403/audience/rate limit).
3. **Evals** + replay fixtures + CI.
4. **README**, the Mastra example, polish.
