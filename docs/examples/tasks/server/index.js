// Backend of the example "Tasks" app. The ecosystem loads this file at startup and calls register().
import { v, allowKeys } from '../../../shared/validate.js';
import { notFound, badRequest } from '../../../shared/errors.js';
import { newId } from '../../../shared/ids.js';
import { reply } from '../../../http/http.js';

const P = '/api/apps/tasks'; // routes MUST live under /api/apps/<app id>/

export function register({ router, services: s }) {
  // Data: your own collection, prefixed with the app id and declared in manifest.dataResources.
  const col = s.storage.collection('tasks_items', { indexes: ['ownerId'] });
  const can = (user, perm) => s.permissions.assert(user, `tasks.${perm}`);   // 403 if the user lacks it
  const mine = (user) => col.find({ where: { ownerId: user.id }, limit: 10000 }); // ALWAYS filter by the session user
  async function own(id, user) {                                               // other people's records look like they don't exist
    const t = await col.get(id);
    if (!t || t.ownerId !== user.id) throw notFound('Task not found');
    return t;
  }
  const stats = async (user) => {
    const all = await mine(user), open = all.filter((t) => !t.done).length;
    return { stats: [{ label: 'Open', value: open }, { label: 'Done', value: all.length - open }] }; // the "stat" widget shape
  };

  router.add('GET', `${P}/items`, async ({ user }) => { await can(user, 'task.read'); return { items: await mine(user) }; });

  router.add('POST', `${P}/items`, async ({ user, body }) => {
    await can(user, 'task.write');
    const b = allowKeys(v.object(body), ['title']);                  // unknown fields (ownerId, id, done...) are rejected
    const item = await col.insert({ id: newId('task'), ownerId: user.id, title: v.string(b.title, 'title', { min: 1, max: 200 }), done: false });
    return reply(201, { item });
  });

  router.add('PATCH', `${P}/items/:id`, async ({ user, params, body }) => {
    await can(user, 'task.write');
    const t = await own(params.id, user);
    const b = allowKeys(v.object(body), ['title', 'done']), patch = {};
    if ('title' in b) patch.title = v.string(b.title, 'title', { min: 1, max: 200 });
    if ('done' in b) { if (typeof b.done !== 'boolean') throw badRequest('done must be true or false'); patch.done = b.done; }
    return { item: await col.update(t.id, patch) };
  });

  router.add('DELETE', `${P}/items/:id`, async ({ user, params }) => {
    await can(user, 'task.write');
    await col.delete((await own(params.id, user)).id);
    return { ok: true };
  });

  router.add('GET', `${P}/stats/summary`, async ({ user }) => { await can(user, 'stats.read'); return stats(user); }); // widget data

  // AI tool (declared in the manifest). Runs only for users who hold tasks.task.read while the app is active.
  s.aiTools?.registerApp('tasks', 'tasks.list', {
    parameters: { properties: { openOnly: { type: 'boolean' } } },
    handler: async (args, { user }) => ({ tasks: (await mine(user)).filter((t) => !args.openOnly || !t.done).slice(0, 50).map((t) => ({ id: t.id, title: t.title, done: t.done })) }),
  });

  // Report provider (declared in the manifest).
  s.reports?.registerApp('tasks', 'tasks-overview', {
    handler: async ({ user, range }) => {
      const all = await mine(user), inRange = (d) => d >= range.from && d <= range.to;
      return { title: 'Tasks overview', sections: [
        { heading: 'Current', stats: (await stats(user)).stats },
        { heading: `Created (${range.label})`, stats: [{ label: 'Tasks created', value: all.filter((t) => inRange(t.createdAt.slice(0, 10))).length }] },
      ] };
    },
  });
}
