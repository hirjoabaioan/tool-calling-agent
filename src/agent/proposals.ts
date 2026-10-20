import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../tools/define.js';
import { executeConfirmed, getTool } from '../tools/registry.js';
import type { Actor } from '../tools/rbac.js';

export const PROPOSAL_TTL_MS = 10 * 60_000;

export interface Proposal {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  confirmLabel: string;
  createdAt: string;
  expiresAt: string;
}

export class ProposalError extends Error {
  constructor(
    public readonly code: 'not_found' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

/** In-memory, keyed by id and bound to the actor that triggered it. */
export class ProposalStore {
  private items = new Map<string, { proposal: Proposal; actorId: string }>();

  create(tool: string, args: Record<string, unknown>, actor: Actor, now: Date): Proposal {
    const def = getTool(tool);
    const proposal: Proposal = {
      id: randomUUID(),
      tool,
      args,
      summary: def?.summarize?.(args) ?? `${tool} ${JSON.stringify(args)}`,
      confirmLabel: def?.confirmLabel ?? 'Confirm',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
    };
    this.items.set(proposal.id, { proposal, actorId: actor.id });
    return proposal;
  }

  /** Another actor's proposal is reported as not found so ids can't be probed. */
  get(id: string, actor: Actor): Proposal | undefined {
    const item = this.items.get(id);
    return item && item.actorId === actor.id ? item.proposal : undefined;
  }

  /** Single use: the proposal is consumed even if execution then fails. */
  async confirm(id: string, ctx: ToolContext): Promise<{ proposal: Proposal; result: unknown }> {
    const proposal = this.get(id, ctx.actor);
    if (!proposal) throw new ProposalError('not_found', `Unknown proposal ${id}`);
    this.items.delete(id);
    if (new Date(proposal.expiresAt) <= ctx.now) throw new ProposalError('expired', `Proposal ${id} has expired`);
    const result = await executeConfirmed(proposal, ctx);
    return { proposal, result };
  }
}

