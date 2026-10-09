import { HttpError } from '../shared/errors.js';

export const CORE_PERMISSIONS = {
  'users.read': 'View users and roles',
  'users.manage': 'Create users, change roles, disable accounts',
  'roles.manage': 'Create and edit roles',
  'apps.manage': 'Install, enable and disable applications',
  'config.manage': 'Change ecosystem configuration',
  'audit.read': 'View the audit log',
  'ai.use': 'Use a personal AI assistant',
  'ai.configure_defaults': 'Set the default AI provider and model',
};

// "*" matches everything, "inventory.*" matches anything starting with "inventory."
export function matches(granted, required) {
  if (granted === '*' || granted === required) return true;
  return granted.endsWith('.*') && required.startsWith(granted.slice(0, -1));
}

// Apps register their permissions (from manifest.json) so admins can only grant real ones,
// and an app can only define permissions inside its own namespace.
export class PermissionRegistry {
  constructor() { this.known = new Map(Object.entries(CORE_PERMISSIONS)); }
  register(appId, perms) {
    for (const p of perms) {
      if (!p.startsWith(`${appId}.`)) throw new Error(`Permission "${p}" must start with "${appId}."`);
      this.known.set(p, '');
    }
  }
  list() { return [...this.known.keys()]; }
  describe() { return [...this.known].map(([id, description]) => ({ id, description })); }
  isValidGrant(p) {
    if (p === '*' || this.known.has(p)) return true;
    return p.endsWith('.*') && this.list().some((k) => k.startsWith(p.slice(0, -1)));
  }
}

export class PermissionService {
  constructor({ storage, registry }) {
    this.roles = storage.collection('roles');
    this.registry = registry;
  }
  getRole(id) { return this.roles.get(id); }

  // Effective permissions = role permissions + per-user grants, minus per-user denies.
  // Disabled users have none.
  async resolve(user) {
    if (!user || user.status !== 'active') return { allow: [], deny: [] };
    const role = await this.roles.get(user.roleId);
    return { allow: [...new Set([...(role?.permissions || []), ...(user.grants || [])])], deny: user.denies || [] };
  }
  static check(res, required) {
    return !res.deny.some((d) => matches(d, required)) && res.allow.some((a) => matches(a, required));
  }
  async can(user, required) { return PermissionService.check(await this.resolve(user), required); }
  async assert(user, required) {
    if (!(await this.can(user, required))) throw new HttpError(403, 'You do not have permission to do that', 'forbidden');
  }
  // Nobody can hand out permissions they do not hold themselves.
  async canGrant(actor, perms) {
    const { allow } = await this.resolve(actor);
    return perms.every((p) => allow.some((a) => matches(a, p)));
  }
  async effectiveList(user) {
    const res = await this.resolve(user);
    return this.registry.list().filter((p) => PermissionService.check(res, p));
  }
  async isAdmin(user) { return (await this.resolve(user)).allow.includes('*'); }
}
