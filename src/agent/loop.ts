import { randomUUID } from 'node:crypto';
import type { Store } from '../domain/store.js';
import type { MeterSink } from '../metering/meter.js';
import type { Message, ToolResultMessage } from '../providers/types.js';
import type { Router } from '../router/router.js';
import type { Tool, ToolContext } from '../tools/define.js';
import type { Actor } from '../tools/rbac.js';
import { toolsFor, toToolSpecs } from '../tools/registry.js';
import { systemPrompt, wrapToolResult } from './prompts.js';
import type { Proposal, ProposalStore } from './proposals.js';

export interface StepRecord {
  step: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number;
  attempts: number;
  fallback: boolean;
  fallbackReason?: string;
  toolCalls: string[];
}

export type AgentResult =
  | { kind: 'text'; text: string; steps: StepRecord[] }
  | { kind: 'proposal'; proposal: Proposal; steps: StepRecord[] }
  | { kind: 'error'; reason: string; steps: StepRecord[] };

export interface RunAgentOptions {
  messages: Message[];
  actor: Actor;
  router: Router;
  store: Store;
  proposals: ProposalStore;
  purpose?: string;
  maxSteps?: number;
  now?: () => Date;
  meter?: MeterSink;
  runId?: string;
  completedActions?: string[];
}

const err = (message: string) => JSON.stringify({ error: message });

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { actor, router, store, proposals } = opts;
  const purpose = opts.purpose ?? 'assistant';
  const maxSteps = opts.maxSteps ?? 8;
  const now = opts.now ?? (() => new Date());
  const runId = opts.runId ?? randomUUID();
  const exposed = new Map<string, Tool>(toolsFor(actor).map((t) => [t.name, t]));
  const specs = toToolSpecs([...exposed.values()]);
  const messages = [...opts.messages];
  const steps: StepRecord[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    let result;
    try {
      result = await router.chat({
        purpose, runId, step, messages, tools: specs,
        system: systemPrompt(actor, now(), opts.completedActions),
      });
    } catch (e) {
      return { kind: 'error', reason: `provider_failure: ${(e as Error).message}`, steps };
    }
    const { response } = result;
    const calls = response.toolCalls ?? [];
    steps.push({
      step, provider: result.provider, model: result.model, tokensIn: response.usage.in, tokensOut: response.usage.out,
      costUsd: result.costUsd, durationMs: result.durationMs, attempts: result.attempts, fallback: result.fallback,
      fallbackReason: result.fallbackReason, toolCalls: calls.map((c) => c.name),
    });

    if (calls.length === 0) return { kind: 'text', text: response.text ?? '', steps };
    messages.push({ role: 'assistant', content: response.text, toolCalls: calls });

    const ctx: ToolContext = { actor, store, now: now() };
    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      const tool = exposed.get(call.name);
      const reply = (content: string) => results.push({ id: call.id, name: call.name, content: wrapToolResult(call.name, content) });

      // RBAC point 2: the model may name a tool it was never shown.
      if (!tool) {
        opts.meter?.record({
          runId, purpose, provider: 'agent', model: call.name, attempt: 1, success: false, errorKind: 'tool_refused',
          fallback: false, durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: null, step,
        });
        reply(err(`Tool "${call.name}" is not available to this user.`));
        continue;
      }
      const parsed = tool.input.safeParse(call.args);
      if (!parsed.success) {
        reply(err(`Invalid arguments: ${parsed.error.message}`));
        continue;
      }
      if (tool.kind === 'write') {
        if (calls.length > 1) {
          reply(err('Write tools must be requested alone in their own turn. Propose this action separately.'));
          continue;
        }
        // Dry-run first: never show a confirm card for an action that would be refused anyway.
        let prepared: unknown = parsed.data;
        try {
          if (tool.prepare) prepared = tool.prepare(parsed.data, ctx);
        } catch (e) {
          reply(err(e instanceof Error ? e.message : String(e)));
          continue;
        }
        const proposal = proposals.create(tool.name, prepared as Record<string, unknown>, actor, ctx.now);
        return { kind: 'proposal', proposal, steps };
      }
      try {
        reply(JSON.stringify(await tool.handler(parsed.data, ctx)));
      } catch (e) {
        reply(err(e instanceof Error ? e.message : String(e)));
      }
    }
    messages.push({ role: 'tool', results });
  }
  return { kind: 'error', reason: 'max_steps', steps };
}

export interface ConfirmOptions extends RunAgentOptions {
  proposalId: string;
}

/** Executes a confirmed proposal, then lets the model continue knowing what is already done. */
export async function confirmAndResume(opts: ConfirmOptions): Promise<{ executed: unknown; next: AgentResult }> {
  const ctx: ToolContext = { actor: opts.actor, store: opts.store, now: (opts.now ?? (() => new Date()))() };
  const { proposal, result } = await opts.proposals.confirm(opts.proposalId, ctx);
  const done = `${proposal.summary} -> ${JSON.stringify(result)}`;
  const next = await runAgent({
    ...opts,
    messages: [
      ...opts.messages,
      { role: 'assistant', content: `Proposed: ${proposal.summary}` },
      { role: 'user', content: 'I confirmed the proposed action. Tell me the outcome.' },
    ],
    completedActions: [...(opts.completedActions ?? []), done],
  });
  return { executed: result, next };
}

