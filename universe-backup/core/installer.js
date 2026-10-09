import { HttpError, notFound, conflict } from '../shared/errors.js';
import { nowIso } from '../shared/ids.js';

// Installation is configuration only: one row per app in `app_installations`.
// Source code and user data are never deleted by uninstall.
export class InstallService {
  constructor({ storage, registry, permissions, audit }) {
    this.col = storage.collection('app_installations');
    Object.assign(this, { storage, registry, permissions, audit });
  }
  async state(id) {
    const row = await this.col.get(id);
    return { installed: !!row, enabled: !!row?.enabled, installedVersion: row?.version ?? null, installedAt: row?.installedAt ?? null };
  }
  async isActive(id) { return !!this.registry.get(id) && (await this.state(id)).enabled; }
  _app(id) { const a = this.registry.get(id); if (!a) throw notFound('Unknown application'); return a; }

  async install(id, actor, ip) {
    const app = this._app(id);
    await this.storage.transaction(async () => {
      if (await this.col.get(id)) throw conflict('Application is already installed', 'already_installed');
      await this.col.insert({ id, version: app.version, enabled: true, installedBy: actor.id, installedAt: nowIso() });
      // Additive default grants; never touches locked roles or removes anything an admin set.
      for (const [roleId, perms] of Object.entries(app.defaultRolePermissions || {})) {
        const role = await this.permissions.roles.get(roleId);
        if (!role || role.locked) continue;
        await this.permissions.roles.update(roleId, { permissions: [...new Set([...role.permissions, ...perms])] });
      }
    });
    await this.audit.record({ actorId: actor.id, action: 'app.install', targetType: 'app', targetId: id, meta: { version: app.version }, ip });
  }
  async setEnabled(id, enabled, actor, ip) {
    this._app(id);
    if (!(await this.col.update(id, { enabled }))) throw new HttpError(409, 'Application is not installed', 'not_installed');
    await this.audit.record({ actorId: actor.id, action: enabled ? 'app.enable' : 'app.disable', targetType: 'app', targetId: id, ip });
  }
  async uninstall(id, actor, ip) {
    this._app(id);
    if (!(await this.col.delete(id))) throw new HttpError(409, 'Application is not installed', 'not_installed');
    await this.audit.record({ actorId: actor.id, action: 'app.uninstall', targetType: 'app', targetId: id, ip });
  }
}
