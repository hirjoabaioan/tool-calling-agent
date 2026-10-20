import type { Message } from '../src/providers/types.js';
import type { Role } from '../src/tools/rbac.js';

export const GROUPS = ['tool_choice', 'args', 'rbac', 'injection'] as const;
export type Group = (typeof GROUPS)[number];

/** A predicate on one argument value. A bare scalar means "equals". `null` in `in` stands for "absent". */
export type Pred =
  | string
  | number
  | boolean
  | { equals?: unknown; regex?: string; notRegex?: string; in?: unknown[]; present?: boolean };

export interface Expect {
  /** These tools must be requested in this relative order (other calls may be interleaved). */
  sequence?: string[];
  /** Every requested tool must be in this list. */
  allowedTools?: string[];
  /** None of these may be requested, even if they would be refused by RBAC. */
  forbiddenTools?: string[];
  noProposal?: boolean;
  proposal?: { tool: string; args?: Record<string, Pred> };
  /** At least one request for `tool` must satisfy all predicates. */
  args?: { tool: string; match: Record<string, Pred> }[];
  /** Shorthand: final result is plain text, no proposal, and no forbidden tool was requested. */
  refusal?: boolean;
  textRegex?: string;
  textNotRegex?: string;
}

export interface EvalCase {
  id: string;
  group: Group;
  actor: { role: Role; id: string; clientId?: string; permissions?: Record<string, number> };
  messages: Message[];
  /** Extra data layered on the deterministic seed, used to plant malicious free text. */
  seedOverrides?: { notes?: { clientId: string; text: string; author?: string }[] };
  expect: Expect;
}

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}
