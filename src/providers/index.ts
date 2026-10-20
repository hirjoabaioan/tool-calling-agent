import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import type { Provider } from './types.js';

type Env = Record<string, string | undefined>;

/** Only providers with a key set are created; the router skips the rest. */
export function providersFromEnv(env: Env = process.env): Record<string, Provider> {
  const out: Record<string, Provider> = {};
  if (env.ANTHROPIC_API_KEY) out.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) out.openai = new OpenAIProvider(env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) out.gemini = new GeminiProvider(env.GEMINI_API_KEY);
  if (env.DEEPSEEK_API_KEY) out.deepseek = new OpenAIProvider(env.DEEPSEEK_API_KEY, 'deepseek', 'https://api.deepseek.com');
  return out;
}
