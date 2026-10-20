export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  id: string;
  name: string;
  content: string;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: ToolResultMessage[] };

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  timeoutMs: number;
}

export interface ChatResponse {
  text?: string;
  toolCalls?: ToolCall[];
  usage: { in: number; out: number };
  raw?: unknown;
}

export interface Provider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type ErrorKind = 'rate_limit' | 'server' | 'timeout' | 'quota' | 'auth' | 'bad_request';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Only transient failures are worth retrying against the same provider. */
export const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['rate_limit', 'server', 'timeout']);
