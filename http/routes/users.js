import { v, allowKeys } from '../../shared/validate.js';
import { HttpError, badRequest, forbidden, notFound, conflict } from '../../shared/errors.js';
import { UserService } from '../../auth/users.js';
import { viewProfile, validateVisibilityPatch } from '../../auth/visibility.js';
import { PermissionService } from '../../auth/permissions.js';
import { reply } from '../http.js';

const MANAGEMENT_PERMS = ['users.manage', 'roles.manage', 'apps.manage', 'config.manage'];

async function countActiveAdmins(s) {
  const adminRoles = (await s.permissions.roles.find({ limit: 1000 })).filter((r) => r.permissions.includes('*')).map((r) => r.id);
  return s.users.col.count({ status: 'active', roleId: { $in: adminRoles } });
}

function validateGrantList(s, list, name) {
  const perms = v.stringArray(list, name, { max: 100 });
  for (const p of perms) {
    if (p === '*') throw badRequest('"*" can only be given through a role');
    if (!s.registry.isValidGrant(p)) throw badRequest(`Unknown permission: ${p}`);
  }
  return perms;
}

export function userRoutes(router, s) {
  const { users, permissions, sessions, audit, registry } = s;

  // Privileged targets (admins, or anyone who can manage users/roles/apps/config) can only be
  // modified by someone who holds every permission they hold.
  async function assertCanModify(user, target) {
    const t = await permissions.resolve(target);
    const privileged = t.allow.includes('*') || MANAGEMENT_PERMS.some((p) => PermissionService.check(t, p));
    if (privileged && !(await permissions.canGrant(user, t.allow))) throw forbidden('You cannot modify a user more powerful than you');
    return t;
  }

  // An admin sets a new password for someone else (there is no email-based reset). Signs them out everywhere.
  router.add('POST', '/api/users/:id/password', async ({ user, params, body, ip }) => {
    await permissions.assert(user, 'users.manage');
    const b = allowKeys(v.object(body), ['newPassword']);
    const target = await users.getById(params.id);
    if (!target) throw notFound('User not found');
    if (target.id === user.id) throw badRequest('To change your own password, use Settings > Password');
    await assertCanModify(user, target);
    await users.setPassword(target.id, b.newPassword);
    await sessions.destroyAllForUser(target.id);
    await audit.record({ actorId: user.id, action: 'user.password_reset', targetType: 'user', targetId: target.id, ip });
    return { ok: true };
  });

  router.add('GET', '/api/permissions', async ({ user }) => {
    await permissions.assert(user, 'users.read');
    return { permissions: registry.describe() };
  });

  router.add('GET', '/api/users', async ({ user }) => {
    await permissions.assert(user, 'users.read');
    return { users: (await users.list()).map(UserService.account) };
  });

  router.add('POST', '/api/users', async ({ user, body, ip }) => {
    await permissions.assert(user, 'users.manage');
    const b = allowKeys(v.object(body), ['email', 'displayName', 'password', 'roleId']);
    const roleId = v.id(b.roleId ?? 'resident', 'roleId');
    const role = await permissions.getRole(roleId);
    if (!role) throw badRequest('Unknown role');
    if (!(await permissions.canGrant(user, role.permissions))) throw forbidden('You cannot assign a role more powerful than your own');
    const created = await users.create({ email: b.email, displayName: b.displayName, password: b.password, roleId });
    await audit.record({ actorId: user.id, action: 'user.create', targetType: 'user', targetId: created.id, meta: { roleId }, ip });
    return reply(201, { user: UserService.account(created) });
  });

  router.add('GET', '/api/users/:id', async ({ user, params }) => {
    if (params.id !== user.id) await permissions.assert(user, 'users.read');
    const t = await users.getById(params.id);
    if (!t) throw notFound('User not found');
    return { user: UserService.account(t) };
  });

  router.add('PATCH', '/api/users/:id', async ({ user, params, body, ip }) => {
    await permissions.assert(user, 'users.manage');
    const b = allowKeys(v.object(body), ['displayName', 'roleId', 'status', 'grants', 'denies']);
    const target = await users.getById(params.id);
    if (!target) throw notFound('User not found');

    const sensitive = ['roleId', 'status', 'grants', 'denies'].some((k) => k in b);
    if (target.id === user.id && sensitive) throw forbidden('You cannot change your own role, status or permissions');

    await assertCanModify(user, target);

    const patch = {};
    if ('displayName' in b) patch.displayName = v.string(b.displayName, 'displayName', { min: 1, max: 80 });
    if ('status' in b) patch.status = v.enum(b.status, 'status', ['active', 'disabled']);
    if ('roleId' in b) {
      const roleId = v.id(b.roleId, 'roleId');
      const role = await permissions.getRole(roleId);
      if (!role) throw badRequest('Unknown role');
      if (!(await permissions.canGrant(user, role.permissions))) throw forbidden('You cannot assign a role more powerful than your own');
      patch.roleId = roleId;
    }
    if ('grants' in b) {
      patch.grants = validateGrantList(s, b.grants, 'grants');
      if (!(await permissions.canGrant(user, patch.grants))) throw forbidden('You cannot grant permissions you do not hold');
    }
    if ('denies' in b) patch.denies = validateGrantList(s, b.denies, 'denies');

    // Never leave the ecosystem without an active admin.
    const targetIsActiveAdmin = target.status === 'active' && (await permissions.isAdmin(target));
    const losesAdmin = (patch.status && patch.status !== 'active') || (patch.roleId && patch.roleId !== target.roleId && !(await permissions.getRole(patch.roleId)).permissions.includes('*'));
    if (targetIsActiveAdmin && losesAdmin && (await countActiveAdmins(s)) <= 1) throw conflict('Cannot remove the last active admin', 'last_admin');

    const updated = await users.update(target.id, patch);
    if (sensitive) await sessions.destroyAllForUser(target.id); // force re-login with new rights
    await audit.record({ actorId: user.id, action: 'user.update', targetType: 'user', targetId: target.id, meta: { fields: Object.keys(patch) }, ip });
    return { user: UserService.account(updated) };
  });

  // ---- own profile ----
  router.add('PATCH', '/api/me', async ({ user, body, ip }) => {
    const b = allowKeys(v.object(body), ['displayName', 'avatarUrl', 'bio']);
    const patch = {};
    if ('displayName' in b) patch.displayName = v.string(b.displayName, 'displayName', { min: 1, max: 80 });
    const profile = { ...user.profile };
    if ('avatarUrl' in b) profile.avatarUrl = b.avatarUrl === null ? null : v.httpsUrl(b.avatarUrl, 'avatarUrl');
    if ('bio' in b) profile.bio = v.string(b.bio, 'bio', { max: 500 });
    const updated = await users.update(user.id, { ...patch, profile });
    await audit.record({ actorId: user.id, action: 'profile.update', targetType: 'user', targetId: user.id, meta: { fields: Object.keys(b) }, ip });
    return { user: UserService.self(updated) };
  });

  router.add('PUT', '/api/me/visibility', async ({ user, body, ip }) => {
    const patch = validateVisibilityPatch(body);
    for (const rule of Object.values(patch)) {
      for (const id of rule.sharedWith) {
        const u = await users.getById(id);
        if (!u || u.id === user.id) throw badRequest('sharedWith contains an unknown user');
      }
    }
    const updated = await users.update(user.id, { profileVisibility: { ...user.profileVisibility, ...patch } });
    await audit.record({ actorId: user.id, action: 'profile.visibility_changed', targetType: 'user', targetId: user.id, meta: { fields: Object.keys(patch) }, ip });
    return { profileVisibility: updated.profileVisibility };
  });

  // Anyone signed in may view another user's profile, but only fields that user chose to expose.
  router.add('GET', '/api/users/:id/profile', async ({ user, params }) => {
    const owner = await users.getById(params.id);
    if (!owner || owner.status !== 'active') throw notFound('User not found');
    return { profile: viewProfile(user, owner) };
  });
}
