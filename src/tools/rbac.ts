export type Role = 'owner' | 'practitioner' | 'receptionist' | 'client';
export type Level = 1 | 2 | 3 | 4;
export interface Permission {
  key: string;
  level: Level;
}

export interface Actor {
  id: string;
  role: Role;
  permissions: Record<string, number>;
  /** Set for role 'client': the only client record this actor may touch. */
  clientId?: string;
}

export interface Guarded {
  audiences: Role[];
  permission?: Permission | Permission[];
}

export function canUse(tool: Guarded, actor: Actor): boolean {
  if (!tool.audiences.includes(actor.role)) return false;
  const required = tool.permission === undefined ? [] : Array.isArray(tool.permission) ? tool.permission : [tool.permission];
  return required.every((p) => (actor.permissions[p.key] ?? 0) >= p.level);
}

// A client holds appointments:3 only because cancel requires it; handlers still scope them to their own data.
export const DEFAULT_PERMISSIONS: Record<Role, Record<string, number>> = {
  owner: { appointments: 4, clients: 4, notes: 4, stats: 4 },
  practitioner: { appointments: 3, clients: 2, notes: 3, stats: 1 },
  receptionist: { appointments: 2, clients: 2 },
  client: { appointments: 3 },
};

export function makeActor(role: Role, id: string, clientId?: string, overrides: Record<string, number> = {}): Actor {
  return { id, role, clientId, permissions: { ...DEFAULT_PERMISSIONS[role], ...overrides } };
}
