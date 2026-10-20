import { GoogleGenAI, type Content } from '@google/genai';
import { classifyError } from './errors.js';
import type { ChatRequest, ChatResponse, Message, Provider } from './types.js';

function toContents(messages: Message[]): Content[] {
  return messages.map((m): Content => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.content }] };
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { output: r.content } } })),
      };
    }
    const parts: NonNullable<Content['parts']> = [];
    if (m.content) parts.push({ text: m.content });
    for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
    return { role: 'model', parts };
  });
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    try {
      const res = await this.client.models.generateContent({
        model: req.model,
        contents: toContents(req.messages),
        config: {
          systemInstruction: req.system,
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
          httpOptions: { timeout: req.timeoutMs },
        },
      });
      // Gemini does not return call ids, so we mint stable ones per response.
      const toolCalls = (res.functionCalls ?? []).map((c, i) => ({
        id: c.id ?? `gemini-call-${i}`,
        name: c.name ?? '',
        args: (c.args ?? {}) as Record<string, unknown>,
      }));
      return {
        text: res.text || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: { in: res.usageMetadata?.promptTokenCount ?? 0, out: res.usageMetadata?.candidatesTokenCount ?? 0 },
      };
    } catch (e) {
      throw classifyError(e);
    }
  }
}
