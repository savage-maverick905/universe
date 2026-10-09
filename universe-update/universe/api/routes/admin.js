import { v, allowKeys } from '../../shared/validate.js';
import { badRequest, forbidden, notFound, conflict } from '../../shared/errors.js';
import { reply } from '../http.js';

export function adminRoutes(router, s) {
  const { permissions, audit, registry, users } = s;

  const cleanPerms = (list) => {
    const perms = v.stringArray(list, 'permissions', { max: 200 });
    for (const p of perms) if (!registry.isValidGrant(p)) throw badRequest(`Unknown permission: ${p}`);
    return perms;
  };

  router.add('GET', '/api/roles', async ({ user }) => {
    await permissions.assert(user, 'users.read');
    return { roles: await permissions.roles.find({ limit: 1000 }) };
  });

  router.add('POST', '/api/roles', async ({ user, body, ip }) => {
    await permissions.assert(user, 'roles.manage');
    const b = allowKeys(v.object(body), ['id', 'name', 'permissions']);
    const id = v.id(b.id, 'id');
    const perms = cleanPerms(b.permissions ?? []);
    if (await permissions.getRole(id)) throw conflict('Role already exists', 'role_exists');
    if (!(await permissions.canGrant(user, perms))) throw forbidden('You cannot create a role more powerful than your own');
    const role = await permissions.roles.insert({ id, name: v.string(b.name, 'name', { min: 1, max: 60 }), permissions: perms, system: false });
    await audit.record({ actorId: user.id, action: 'role.create', targetType: 'role', targetId: id, meta: { permissions: perms }, ip });
    return reply(201, { role });
  });

  router.add('PATCH', '/api/roles/:id', async ({ user, params, body, ip }) => {
    await permissions.assert(user, 'roles.manage');
    const role = await permissions.getRole(params.id);
    if (!role) throw notFound('Role not found');
    if (role.locked) throw forbidden('This role is locked');
    const b = allowKeys(v.object(body), ['name', 'permissions']);
    const patch = {};
    if ('name' in b) patch.name = v.string(b.name, 'name', { min: 1, max: 60 });
    if ('permissions' in b) {
      patch.permissions = cleanPerms(b.permissions);
      if (!(await permissions.canGrant(user, [...role.permissions, ...patch.permissions]))) throw forbidden('You cannot edit a role more powerful than your own');
    }
    const updated = await permissions.roles.update(role.id, patch);
    await audit.record({ actorId: user.id, action: 'role.update', targetType: 'role', targetId: role.id, meta: patch, ip });
    return { role: updated };
  });

  router.add('DELETE', '/api/roles/:id', async ({ user, params, ip }) => {
    await permissions.assert(user, 'roles.manage');
    const role = await permissions.getRole(params.id);
    if (!role) throw notFound('Role not found');
    if (role.system) throw forbidden('System roles cannot be deleted');
    if ((await users.col.count({ roleId: role.id })) > 0) throw conflict('Role is still assigned to users', 'role_in_use');
    await permissions.roles.delete(role.id);
    await audit.record({ actorId: user.id, action: 'role.delete', targetType: 'role', targetId: role.id, ip });
    return { ok: true };
  });

  // Who can sign up, and what they get. Admin only (config.manage).
  router.add('GET', '/api/admin/signup', async ({ user }) => {
    await permissions.assert(user, 'config.manage');
    return { settings: await s.authSettings.get() };
  });
  router.add('PUT', '/api/admin/signup', async ({ user, body, ip }) => {
    await permissions.assert(user, 'config.manage');
    const b = allowKeys(v.object(body), ['signupEnabled', 'signupRoleId', 'signupAllowAi']);
    const patch = {};
    for (const k of ['signupEnabled', 'signupAllowAi']) if (k in b) { if (typeof b[k] !== 'boolean') throw badRequest(`${k} must be true or false`); patch[k] = b[k]; }
    if ('signupRoleId' in b) {
      const role = await permissions.getRole(v.id(b.signupRoleId, 'signupRoleId'));
      if (!role) throw badRequest('Unknown role');
      if (role.permissions.includes('*')) throw badRequest('New sign-ups cannot be given an admin role');
      patch.signupRoleId = role.id;
    }
    await s.authSettings.set(patch);
    await audit.record({ actorId: user.id, action: 'config.signup_changed', meta: patch, ip });
    return { settings: await s.authSettings.get() };
  });

  router.add('GET', '/api/audit', async ({ user, query }) => {
    await permissions.assert(user, 'audit.read');
    const num = (k, d) => { const n = parseInt(query.get(k) ?? '', 10); return Number.isFinite(n) ? n : d; };
    return { entries: await audit.list({
      limit: Math.min(num('limit', 50), 200), offset: Math.max(num('offset', 0), 0),
      actorId: query.get('actorId') || undefined, action: query.get('action') || undefined }) };
  });
}
