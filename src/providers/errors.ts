import { ProviderError } from './types.js';

/** SDK-agnostic: duck-types status/name/code so every adapter shares one mapping. */
export function classifyError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = (e ?? {}) as { status?: unknown; name?: unknown; code?: unknown; message?: unknown };
  const message = typeof err.message === 'string' ? err.message : String(e);
  const status = typeof err.status === 'number' ? err.status : undefined;
  const name = typeof err.name === 'string' ? err.name : '';
  const code = typeof err.code === 'string' ? err.code : '';

  if (/timeout|timedout|abort/i.test(name) || /ETIMEDOUT/.test(code) || status === 408) {
    return new ProviderError('timeout', message, status);
  }
  if (status === 402 || /insufficient_quota|billing|quota/i.test(code + message)) {
    return new ProviderError('quota', message, status);
  }
  if (status === 429) return new ProviderError('rate_limit', message, status);
  if (status === 401 || status === 403) return new ProviderError('auth', message, status);
  if (status !== undefined && status >= 400 && status < 500) return new ProviderError('bad_request', message, status);
  // Network failures without a status are treated like server errors.
  return new ProviderError('server', message, status);
}
