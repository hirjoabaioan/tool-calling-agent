import type { z } from 'zod';
import type { Store } from '../domain/store.js';
import type { Actor, Guarded, Permission, Role } from './rbac.js';

export interface ToolContext {
  actor: Actor;
  store: Store;
  now: Date;
}

export class ToolError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'invalid_args' | 'unknown_tool' | 'not_a_write_tool' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolInit<S extends z.ZodType> {
  name: string;
  description: string;
  kind: 'read' | 'write';
  audiences: Role[];
  permission?: Permission | Permission[];
  input: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  /** Human-readable one-liner shown on the proposal (write tools). */
  summarize?: (args: z.infer<S>) => string;
  confirmLabel?: string;
}

export interface Tool extends Guarded {
  name: string;
  description: string;
  kind: 'read' | 'write';
  input: z.ZodType;
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
  summarize?: (args: unknown) => string;
  confirmLabel?: string;
}

export function defineTool<S extends z.ZodType>(init: ToolInit<S>): Tool {
  // Erasing the schema type here keeps the registry a plain Tool[]; args are always
  // parsed with `input` before the handler runs, so the cast is sound.
  return init as unknown as Tool;
}
