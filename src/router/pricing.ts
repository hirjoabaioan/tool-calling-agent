export interface Price {
  /** USD per 1M input tokens */
  in: number;
  /** USD per 1M output tokens */
  out: number;
}

// Indicative list prices, USD per 1M tokens. Verify against the sources before relying on them.
// asOf: 2026-10-20
// sources:
//   Anthropic  https://www.anthropic.com/pricing
//   OpenAI     https://openai.com/api/pricing
//   Google     https://ai.google.dev/gemini-api/docs/pricing
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
export const PRICING: Record<string, Price> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'deepseek-chat': { in: 0.28, out: 0.42 },
};

/** Returns null (not 0) for unknown models so reports never under-count silently. */
export function costUsd(model: string, tokensIn: number, tokensOut: number, table = PRICING): number | null {
  const p = table[model];
  if (!p) return null;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
