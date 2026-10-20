import type { ChatRequest, ChatResponse, Provider, ToolCall } from './types.js';
import { ProviderError } from './types.js';

export interface MockReply {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
  usage?: { in: number; out: number };
}

export type MockStep = MockReply | ProviderError | ((req: ChatRequest) => MockReply | ProviderError);

/** Scriptable provider: each chat() call shifts one step off the queue. */
export class MockProvider implements Provider {
  readonly calls: ChatRequest[] = [];
  private queue: MockStep[] = [];
  private idSeq = 0;

  constructor(public readonly name = 'mock') {}

  push(...steps: MockStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const step = this.queue.shift();
    if (step === undefined) throw new Error('MockProvider: response queue is empty');
    const reply = typeof step === 'function' ? step(req) : step;
    if (reply instanceof ProviderError) throw reply;
    const toolCalls: ToolCall[] | undefined = reply.toolCalls?.map((c) => ({
      id: c.id ?? `mock-call-${++this.idSeq}`,
      name: c.name,
      args: c.args,
    }));
    return { text: reply.text, toolCalls, usage: reply.usage ?? { in: 100, out: 20 } };
  }
}
