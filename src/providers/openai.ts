import OpenAI from 'openai';
import { classifyError } from './errors.js';
import type { ChatRequest, ChatResponse, Message, Provider } from './types.js';

function toOpenAIMessages(system: string, messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    } else {
      out.push({
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    }
  }
  return out;
}

/** Also serves any OpenAI-compatible endpoint (e.g. DeepSeek) through `baseURL`. */
export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(
    apiKey: string,
    public readonly name = 'openai',
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.system, req.messages),
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        },
        { timeout: req.timeoutMs },
      );
      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap((c) =>
        c.type === 'function'
          ? [{ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || '{}') as Record<string, unknown> }]
          : [],
      );
      return {
        text: msg?.content || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: { in: res.usage?.prompt_tokens ?? 0, out: res.usage?.completion_tokens ?? 0 },
      };
    } catch (e) {
      throw classifyError(e);
    }
  }
}
