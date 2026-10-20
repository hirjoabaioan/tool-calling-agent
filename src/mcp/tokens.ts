import { createHash } from 'node:crypto';
import type { Role } from '../tools/rbac.js';

export interface TokenInfo {
  actorId: string;
  role: Role;
  /** Must equal the server id; a token minted for another resource is rejected. */
  audience: string;
  /** Required for role 'client': the only client record that token may touch. */
  clientId?: string;
}

export type TokenMap = Record<string, TokenInfo>;

const ROLES: readonly string[] = ['owner', 'practitioner', 'receptionist', 'client'];

export const sha256Hex = (token: string): string => createHash('sha256').update(token).digest('hex');

/** MCP_TOKENS is a JSON object: sha256(token) -> { actorId, role, audience }. Only hashes are ever stored. */
export function parseTokens(json: string | undefined): TokenMap {
  if (!json) return {};
  const raw = JSON.parse(json) as Record<string, Partial<TokenInfo>>;
  const out: TokenMap = {};
  for (const [hash, v] of Object.entries(raw)) {
    if (!v.actorId || !v.audience || !v.role || !ROLES.includes(v.role)) {
      throw new Error(`MCP_TOKENS entry ${hash.slice(0, 8)}... needs actorId, audience and a valid role`);
    }
    out[hash.toLowerCase()] = { actorId: v.actorId, role: v.role, audience: v.audience, clientId: v.clientId };
  }
  return out;
}
