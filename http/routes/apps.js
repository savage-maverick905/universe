import { v, allowKeys } from '../../shared/validate.js';
import { HttpError } from '../../shared/errors.js';
import { verifyPassword } from '../../auth/passwords.js';
import { tooMany } from '../middleware.js';
import { clearUserData } from '../../core/dataClear.js';

const pub = (a) => ({ id: a.id, name: a.name, version: a.version, description: a.description, icon: a.icon ?? null });

export function appRoutes(router, s) {
  const { registry, installer, permissions } = s;
  const ok = { ok: true };

  router.add('GET', '/api/apps', async () => {
    const apps = [];
    for (const a of registry.list()) {
      const st = await installer.state(a.id);
      apps.push({ ...pub(a), ...st, status: !st.installed ? 'available' : st.enabled ? 'enabled' : 'disabled', openUrl: st.enabled ? `/apps/${a.id}/` : null });
    }
    return { apps };
  });

  for (const [action, fn] of [
    ['install', (id, u, ip) => installer.install(id, u, ip)],
    ['enable', (id, u, ip) => installer.setEnabled(id, true, u, ip)],
    ['disable', (id, u, ip) => installer.setEnabled(id, false, u, ip)],
    ['uninstall', (id, u, ip) => installer.uninstall(id, u, ip)],
  ]) {
    router.add('POST', `/api/apps/:id/${action}`, async ({ user, params, ip }) => {
      await permissions.assert(user, 'apps.manage');
      await fn(params.id, user, ip);
      return ok;
    });
  }

  // ---- Clear data: wipes what THIS user saved in one app (or every app). Needs the account password. ----
  async function clear(user, body, ip, ids) {
    const b = allowKeys(v.object(body), ['password']);
    const pw = v.string(b.password, 'password', { min: 1, max: 256, trim: false });
    const rl = s.limiters.loginEmail.check(user.email); if (!rl.allowed) throw tooMany(rl.retryAfterSec);
    if (!(await verifyPassword(pw, user.passwordHash))) { s.limiters.loginEmail.hit(user.email); throw new HttpError(401, 'Password is incorrect', 'invalid_credentials'); }
    const removed = await clearUserData({ storage: s.storage, registry }, user, ids);
    await s.audit.record({ actorId: user.id, action: 'app.clear_data', targetType: 'app', targetId: ids.length === 1 ? ids[0] : 'all', meta: { removed }, ip });
    return { ok: true, removed };
  }
  router.add('POST', '/api/apps/clear-all-data', ({ user, body, ip }) => clear(user, body, ip, registry.list().map((a) => a.id)));
  router.add('POST', '/api/apps/:id/clear-data', ({ user, params, body, ip }) => clear(user, body, ip, [params.id]));

  // Widgets come from manifests of active apps, filtered by what THIS user may see.
  router.add('GET', '/api/dashboard/widgets', async ({ user }) => {
    const widgets = [];
    for (const a of registry.list()) {
      if (!(await installer.isActive(a.id))) continue;
      for (const w of a.widgets || []) {
        if (w.requiredPermission && !(await permissions.can(user, w.requiredPermission))) continue;
        widgets.push({ appId: a.id, appName: a.name, id: w.id, title: w.title, type: w.type, dataEndpoint: w.dataEndpoint });
      }
    }
    return { widgets };
  });
}
