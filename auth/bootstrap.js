export const DEFAULT_ROLES = [
  { id: 'admin', name: 'Admin', permissions: ['*'], system: true, locked: true },
  { id: 'resident', name: 'Resident', permissions: ['ai.use'], system: true },
  { id: 'guest', name: 'Guest', permissions: [], system: true },
];

// Inserts missing default roles; never overwrites roles an admin has edited.
export async function ensureDefaultRoles(storage) {
  const roles = storage.collection('roles');
  for (const r of DEFAULT_ROLES) if (!(await roles.get(r.id))) await roles.insert(r);
}

// Creates the first admin from env vars, only when no users exist yet.
export async function ensureBootstrapAdmin({ users, config, audit, log = console }) {
  if ((await users.count()) > 0) return null;
  const { email, password } = config.bootstrap;
  if (!email || !password) {
    log.warn('No users exist. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD and restart to create the first admin.');
    return null;
  }
  const admin = await users.create({ email, displayName: 'Admin', password, roleId: 'admin' });
  await audit.record({ actorId: null, action: 'bootstrap.admin_created', targetType: 'user', targetId: admin.id });
  log.info(`Created first admin ${admin.email}. Remove BOOTSTRAP_ADMIN_PASSWORD from your environment now.`);
  return admin;
}
