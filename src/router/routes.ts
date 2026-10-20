export interface Route {
  provider: string;
  model: string;
}

type Env = Record<string, string | undefined>;

// Model ids live here and can be overridden per provider via env.
const DEFAULT_MODELS = {
  anthropic: { env: 'ANTHROPIC_MODEL', model: 'claude-haiku-4-5' },
  openai: { env: 'OPENAI_MODEL', model: 'gpt-4.1-mini' },
  gemini: { env: 'GEMINI_MODEL', model: 'gemini-2.5-flash' },
  deepseek: { env: 'DEEPSEEK_MODEL', model: 'deepseek-chat' },
} as const;

const ORDER: Record<string, (keyof typeof DEFAULT_MODELS)[]> = {
  assistant: ['anthropic', 'openai', 'gemini', 'deepseek'],
};

export function routesFor(purpose: string, env: Env = process.env): Route[] {
  const order = ORDER[purpose];
  if (!order) throw new Error(`No routes configured for purpose "${purpose}"`);
  return order.map((provider) => {
    const d = DEFAULT_MODELS[provider];
    return { provider, model: env[d.env] || d.model };
  });
}
