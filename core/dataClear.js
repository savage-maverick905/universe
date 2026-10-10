import { notFound } from '../shared/errors.js';

// "Clear data" removes what ONE person saved inside apps. It never touches other people's records, the person's account,
// password, roles, or the app installation itself. An app can list collections to keep in `preserveOnClear`
// (Orbit keeps its Finance PIN so clearing money data does not also remove the lock).
// Records are matched by owner. Most collections use `ownerId`; Inventory items use `ownership.ownerId`.
export async function clearUserData({ storage, registry }, user, appIds) {
  const apps = appIds.map((id) => { const a = registry.get(id); if (!a) throw notFound('Unknown application'); return a; });
  const removed = {};
  await storage.transaction(async () => {
    for (const app of apps) {
      const keep = new Set(app.preserveOnClear || []);
      let n = 0;
      for (const name of app.dataResources || []) {
        if (keep.has(name)) continue;
        const col = storage.collection(name);
        n += await col.deleteWhere({ ownerId: user.id });
        n += await col.deleteWhere({ 'ownership.ownerId': user.id });
      }
      removed[app.id] = n;
    }
  });
  return removed;
}
