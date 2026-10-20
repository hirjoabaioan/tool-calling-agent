import Anthropic from '@anthropic-ai/sdk';
import { classifyError } from './errors.js';
import type { ChatRequest, ChatResponse, Message, Provider } from './types.js';

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content })),
      };
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
    return { role: 'assistant', content: blocks };
  });
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    // Org-level keys that are not scoped to a workspace must name one per request.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    this.client = new Anthropic({
      apiKey,
      maxRetries: 0,
      ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: 1024,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
          })),
        },
        { timeout: req.timeoutMs },
      );
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const toolCalls = res.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, args: b.input as Record<string, unknown> }] : [],
      );
      return {
        text: text || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: { in: res.usage.input_tokens, out: res.usage.output_tokens },
      };
    } catch (e) {
      throw classifyError(e);
    }
  }
}
