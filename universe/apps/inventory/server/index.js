import { v, allowKeys } from '../../../shared/validate.js';
import { HttpError, badRequest, notFound, conflict } from '../../../shared/errors.js';
import { newId, nowIso } from '../../../shared/ids.js';
import { reply } from '../../../api/http.js';
import { STATUSES, CONDITIONS, METHODS, ATTENTION, blankItem, parseItemPatch, mergeItem, parseName, parseParent } from './schema.js';

const P = '/api/apps/inventory';
const DEFAULT_CATEGORIES = ['Electronics', 'Furniture', 'Clothing', 'Tools', 'Documents', 'Other'];
const MAX_HISTORY = 500;

export function register({ router, services: s }) {
  const { permissions, audit, storage } = s;
  const items = storage.collection('inventory_items', { indexes: ['ownership.ownerId'] });
  const cats = storage.collection('inventory_categories', { indexes: ['ownerId'] });
  const locs = storage.collection('inventory_locations', { indexes: ['ownerId'] });
  const settings = storage.collection('inventory_settings');
  const cloudName = s.config.cloudinary?.cloudName || '';
  const can = (u, p) => permissions.assert(u, `inventory.${p}`);
  const mine = (col, user, where = {}) => col.find({ where: { ...(col === items ? { 'ownership.ownerId': user.id } : { ownerId: user.id }), ...where }, limit: 10000 });
  // Everything is scoped to the signed-in user. Other users' records look like they don't exist (404).
  async function own(col, id, user, what = 'Item') {
    const d = await col.get(id);
    if (!d || (d.ownership?.ownerId ?? d.ownerId) !== user.id) throw notFound(`${what} not found`);
    return d;
  }
  async function seed(user) {
    if (await settings.get(`seed_${user.id}`)) return;
    await storage.transaction(async () => {
      if (await settings.get(`seed_${user.id}`)) return;
      for (const name of DEFAULT_CATEGORIES) await cats.insert({ id: newId('cat'), ownerId: user.id, name, icon: null });
      await settings.insert({ id: `seed_${user.id}`, ownerId: user.id });
    });
  }
  async function checkRefs(user, it) {
    const { categoryId } = it.identity, { locationId } = it.location, { parentItemId, relatedItems } = it.relationships;
    if (categoryId) await own(cats, categoryId, user, 'Category').catch(() => { throw badRequest('Unknown category'); });
    if (locationId) await own(locs, locationId, user, 'Location').catch(() => { throw badRequest('Unknown location'); });
    for (const id of [parentItemId, ...relatedItems].filter(Boolean)) {
      if (id === it.id) throw badRequest('An item cannot relate to itself');
      await own(items, id, user).catch(() => { throw badRequest('Unknown related item'); });
    }
    for (let cur = parentItemId, d = 0; cur && d < 25; d++) { // no parent loops
      if (cur === it.id) throw badRequest('Parent relationship would create a loop');
      cur = (await items.get(cur))?.relationships.parentItemId;
    }
  }
  const diffHistory = (old, nu) => {
    const out = [], date = nowIso().slice(0, 10);
    if (old.status.state !== nu.status.state) out.push({ date, event: 'status_changed', from: old.status.state, to: nu.status.state, reason: nu.status.reason || '' });
    if (old.location.locationId !== nu.location.locationId) out.push({ date, event: 'moved', from: old.location.locationId, to: nu.location.locationId, reason: '' });
    if (old.condition.state !== nu.condition.state) out.push({ date, event: 'condition_changed', from: old.condition.state, to: nu.condition.state, reason: nu.condition.notes || '' });
    return out;
  };

  // ---- meta (labels + public upload settings; never secrets) ----
  router.add('GET', `${P}/meta`, async ({ user }) => {
    await can(user, 'item.read');
    const lab = (o) => Object.entries(o).map(([id, label]) => ({ id, label }));
    const c = s.config.cloudinary || {};
    return { statuses: lab(STATUSES), conditions: lab(CONDITIONS), acquisitionMethods: lab(METHODS),
      cloudinary: c.cloudName && c.uploadPreset ? { cloudName: c.cloudName, uploadPreset: c.uploadPreset, folder: `universe/inventory/${user.id}`, tags: ['universe', 'inventory'], maxBytes: 10 * 1024 * 1024 } : null };
  });

  // ---- items ----
  async function queryItems(user, g) {
    const q = (g('q') || '').trim().toLowerCase();
    let list = (await mine(items, user)).filter((i) => i.archived === (g('archived') === 'true'));
    if (g('status')) list = list.filter((i) => i.status.state === g('status'));
    if (g('category')) list = list.filter((i) => i.identity.categoryId === g('category'));
    if (g('location')) list = list.filter((i) => i.location.locationId === g('location'));
    if (g('tag')) list = list.filter((i) => i.identity.tags.includes(g('tag').toLowerCase()));
    if (q) list = list.filter((i) => [i.identity.name, i.identity.description, i.identity.tags.join(' '), i.identification.brand, i.identification.model, i.identification.serialNumber, i.notes].some((x) => x && String(x).toLowerCase().includes(q)));
    const sort = ['name', 'createdAt', 'updatedAt', 'price'].includes(g('sort')) ? g('sort') : 'updatedAt', dir = g('dir') === 'asc' ? 1 : -1;
    const key = (i) => (sort === 'name' ? i.identity.name.toLowerCase() : sort === 'price' ? i.acquisition.price ?? -1 : i[sort]);
    list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * dir);
    const limit = Math.min(Math.max(parseInt(g('limit'), 10) || 200, 1), 500), offset = Math.max(parseInt(g('offset'), 10) || 0, 0);
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }
  router.add('GET', `${P}/items`, async ({ user, query }) => { await can(user, 'item.read'); return queryItems(user, (k) => query.get(k) || ''); });

  router.add('POST', `${P}/items`, async ({ user, body, ip }) => {
    await can(user, 'item.write');
    const patch = parseItemPatch(body, { cloudName });
    if (!patch.identity?.name) throw badRequest('identity.name is required');
    const now = nowIso(), item = { id: newId('item'), schemaVersion: 1, ...mergeItem(blankItem(), patch),
      ownership: { type: 'personal', ownerId: user.id }, archived: false, createdAt: now, updatedAt: now,
      history: [{ date: now.slice(0, 10), event: 'created', reason: patch.acquisition?.method ? METHODS[patch.acquisition.method] : '' }] };
    await checkRefs(user, item);
    await items.insert(item);
    await audit.record({ actorId: user.id, action: 'inventory.item.create', targetType: 'item', targetId: item.id, ip });
    return reply(201, { item });
  });

  router.add('GET', `${P}/items/:id`, async ({ user, params }) => { await can(user, 'item.read'); return { item: await own(items, params.id, user) }; });

  router.add('PATCH', `${P}/items/:id`, async ({ user, params, body, ip }) => {
    await can(user, 'item.write');
    const old = await own(items, params.id, user);
    const merged = mergeItem(old, parseItemPatch(body, { cloudName }));
    if (!merged.identity.name) throw badRequest('identity.name is required');
    await checkRefs(user, merged);
    merged.history = [...old.history, ...diffHistory(old, merged)].slice(-MAX_HISTORY);
    const item = await items.update(old.id, { ...merged, id: old.id, ownership: old.ownership, archived: old.archived });
    await audit.record({ actorId: user.id, action: 'inventory.item.update', targetType: 'item', targetId: old.id, ip });
    return { item };
  });

  router.add('POST', `${P}/items/:id/history`, async ({ user, params, body }) => {
    await can(user, 'item.write');
    const old = await own(items, params.id, user);
    const b = allowKeys(v.object(body), ['reason', 'date']);
    const date = b.date ? v.string(b.date, 'date', { max: 10 }) : nowIso().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date must be like 2026-01-15');
    const entry = { date, event: 'note', reason: v.string(b.reason, 'reason', { min: 1, max: 300 }) };
    return { item: await items.update(old.id, { history: [...old.history, entry].slice(-MAX_HISTORY) }) };
  });

  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    router.add('POST', `${P}/items/:id/${action}`, async ({ user, params, ip }) => {
      await can(user, 'item.write');
      const old = await own(items, params.id, user);
      const item = await items.update(old.id, { archived, history: [...old.history, { date: nowIso().slice(0, 10), event: archived ? 'archived' : 'restored', reason: '' }].slice(-MAX_HISTORY) });
      await audit.record({ actorId: user.id, action: `inventory.item.${action}`, targetType: 'item', targetId: old.id, ip });
      return { item };
    });
  }

  router.add('DELETE', `${P}/items/:id`, async ({ user, params, ip }) => {
    await can(user, 'item.delete');
    const old = await own(items, params.id, user);
    if (!old.archived) throw conflict('Archive the item before deleting it permanently', 'not_archived');
    await items.delete(old.id);
    for (const o of await mine(items, user)) { // remove dangling references
      const r = o.relationships;
      if (r.parentItemId === old.id || r.relatedItems.includes(old.id))
        await items.update(o.id, { relationships: { parentItemId: r.parentItemId === old.id ? null : r.parentItemId, relatedItems: r.relatedItems.filter((x) => x !== old.id) } });
    }
    await audit.record({ actorId: user.id, action: 'inventory.item.delete', targetType: 'item', targetId: old.id, ip });
    return { ok: true };
  });

  // ---- categories & locations ----
  const taxonomy = (path, col, label, inUse, hasParent) => {
    router.add('GET', `${P}/${path}`, async ({ user }) => {
      await can(user, 'item.read'); if (col === cats) await seed(user);
      return { [path]: (await mine(col, user)).sort((a, b) => a.name.localeCompare(b.name)) };
    });
    router.add('POST', `${P}/${path}`, async ({ user, body }) => {
      await can(user, col === cats ? 'category.manage' : 'location.manage');
      const b = allowKeys(v.object(body), hasParent ? ['name', 'parentId'] : ['name', 'icon']);
      const doc = { id: newId(col === cats ? 'cat' : 'loc'), ownerId: user.id, name: parseName(b.name, 'name') };
      if (hasParent) { doc.parentId = parseParent(b.parentId, 'parentId'); if (doc.parentId) await own(col, doc.parentId, user, label); }
      else doc.icon = b.icon == null ? null : v.string(b.icon, 'icon', { max: 8 });
      return reply(201, { [label.toLowerCase()]: await col.insert(doc) });
    });
    router.add('PATCH', `${P}/${path}/:id`, async ({ user, params, body }) => {
      await can(user, col === cats ? 'category.manage' : 'location.manage');
      const old = await own(col, params.id, user, label);
      const b = allowKeys(v.object(body), hasParent ? ['name', 'parentId'] : ['name', 'icon']), patch = {};
      if ('name' in b) patch.name = parseName(b.name, 'name');
      if ('icon' in b) patch.icon = b.icon == null ? null : v.string(b.icon, 'icon', { max: 8 });
      if ('parentId' in b) {
        patch.parentId = parseParent(b.parentId, 'parentId');
        if (patch.parentId) {
          for (let cur = patch.parentId, d = 0; cur && d < 25; d++) { // parent must exist and must not be self or a descendant
            if (cur === old.id) throw badRequest('A location cannot be placed inside itself');
            cur = (await own(col, cur, user, label)).parentId;
          }
        }
      }
      return { [label.toLowerCase()]: await col.update(old.id, patch) };
    });
    router.add('DELETE', `${P}/${path}/:id`, async ({ user, params }) => {
      await can(user, col === cats ? 'category.manage' : 'location.manage');
      const old = await own(col, params.id, user, label);
      if (await inUse(user, old.id)) throw conflict(`${label} is still in use`, 'in_use');
      await col.delete(old.id);
      return { ok: true };
    });
  };
  taxonomy('categories', cats, 'Category', async (u, id) => (await mine(items, u)).some((i) => i.identity.categoryId === id), false);
  taxonomy('locations', locs, 'Location', async (u, id) => (await mine(items, u)).some((i) => i.location.locationId === id) || (await mine(locs, u)).some((l) => l.parentId === id), true);

  // ---- statistics (widgets) ----
  const active = async (user) => { await can(user, 'stats.read'); return (await mine(items, user)).filter((i) => !i.archived); };
  const tally = (list, keyFn, names) => { const m = new Map(); for (const i of list) { const k = keyFn(i) ?? '_none'; m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([k, value]) => ({ label: k === '_none' ? 'None' : names.get(k) || 'Unknown', value })).sort((a, b) => b.value - a.value); };
  const statsOf = (list) => {
    const n = (st) => list.filter((i) => i.status.state === st).length;
    const money = {}; for (const i of list) if (i.acquisition.price != null && i.acquisition.currency) money[i.acquisition.currency] = (money[i.acquisition.currency] || 0) + i.acquisition.price;
    const value = Object.entries(money).map(([c, a]) => `${c} ${a.toLocaleString('en-US')}`).join(', ') || 'Not recorded';
    return { stats: [{ label: 'Total items', value: list.length }, { label: 'In use', value: n('in_use') }, { label: 'Not in use', value: n('not_in_use') }, { label: 'Lost', value: n('lost') },
      { label: 'Lent out', value: n('lent_out') }, { label: 'Needs attention', value: list.filter((i) => ATTENTION.includes(i.status.state)).length }, { label: 'Estimated value', value }] };
  };
  const summaryStats = async (user) => statsOf((await mine(items, user)).filter((i) => !i.archived));
  router.add('GET', `${P}/stats/summary`, async ({ user }) => { await can(user, 'stats.read'); return summaryStats(user); });
  router.add('GET', `${P}/stats/by-category`, async ({ user }) => {
    const list = await active(user); const names = new Map((await mine(cats, user)).map((c) => [c.id, c.name]));
    return { series: tally(list, (i) => i.identity.categoryId, names) };
  });
  router.add('GET', `${P}/stats/by-location`, async ({ user }) => {
    const list = await active(user); const names = new Map((await mine(locs, user)).map((l) => [l.id, l.name]));
    return { series: tally(list, (i) => i.location.locationId, names) };
  });
  router.add('GET', `${P}/stats/recent`, async ({ user }) => {
    const list = (await active(user)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 5);
    return { items: list.map((i) => ({ title: i.identity.name, subtitle: `${STATUSES[i.status.state]}, added ${i.createdAt.slice(0, 10)}` })) };
  });

  // ---- JSON export / import (the signed-in user's own data only) ----
  router.add('GET', `${P}/export`, async ({ user, ip }) => {
    await can(user, 'item.read');
    await audit.record({ actorId: user.id, action: 'inventory.export', ip });
    return reply(200, { format: 'universe-app-export', app: 'inventory', schemaVersion: 1, exportedAt: nowIso(),
      items: await mine(items, user), categories: await mine(cats, user), locations: await mine(locs, user) },
    { 'Content-Disposition': 'attachment; filename="universe-inventory.json"' });
  });

  router.add('POST', `${P}/import`, async ({ user, body, ip }) => {
    await can(user, 'item.write'); await can(user, 'category.manage'); await can(user, 'location.manage');
    if (body?.format !== 'universe-app-export' || body.app !== 'inventory') throw badRequest('Not an inventory export');
    if (body.schemaVersion !== 1) throw badRequest(`Unsupported schemaVersion ${body.schemaVersion}`);
    const arr = (x, max) => { if (!Array.isArray(x) || x.length > max) throw badRequest(`Import is limited to ${max} entries per list`); return x; };
    const [inItems, inCats, inLocs] = [arr(body.items ?? [], 2000), arr(body.categories ?? [], 500), arr(body.locations ?? [], 500)];
    // Ids from a file are never trusted: every record gets a fresh id owned by the importer, so an
    // import can never overwrite someone else's data. References are remapped.
    const map = new Map(); const fresh = (old, prefix) => { const id = newId(prefix); map.set(old, id); return id; };
    const counts = { items: 0, categories: 0, locations: 0 };
    await storage.transaction(async () => {
      for (const c of inCats) { await cats.insert({ id: fresh(c.id, 'cat'), ownerId: user.id, name: parseName(c.name, 'category name'), icon: null }); counts.categories++; }
      for (const l of inLocs) fresh(l.id, 'loc');
      for (const l of inLocs) { await locs.insert({ id: map.get(l.id), ownerId: user.id, name: parseName(l.name, 'location name'), parentId: map.get(l.parentId) ?? null }); counts.locations++; }
      for (const it of inItems) fresh(it.id, 'item');
      for (const it of inItems) {
        const { id, ownership, history, createdAt, updatedAt, archived, ...rest } = it;
        const clean = { ...rest, identity: { ...rest.identity, categoryId: map.get(rest.identity?.categoryId) ?? null }, location: { ...rest.location, locationId: map.get(rest.location?.locationId) ?? null },
          relationships: { parentItemId: map.get(rest.relationships?.parentItemId) ?? null, relatedItems: (rest.relationships?.relatedItems || []).map((x) => map.get(x)).filter(Boolean) } };
        delete clean.schemaVersion;
        if (clean.media) clean.media = { images: clean.media.images ?? [] }; // documents are not supported yet
        const patch = parseItemPatch(clean, { cloudName });
        if (!patch.identity?.name) throw badRequest('Every imported item needs identity.name');
        const now = nowIso();
        const hist = Array.isArray(history) ? history.filter((h) => h && typeof h.event === 'string' && typeof h.date === 'string').slice(-MAX_HISTORY).map((h) => ({ date: h.date.slice(0, 10), event: h.event.slice(0, 40), reason: String(h.reason ?? '').slice(0, 300), ...(h.from != null ? { from: String(h.from).slice(0, 100) } : {}), ...(h.to != null ? { to: String(h.to).slice(0, 100) } : {}) })) : [];
        await items.insert({ id: map.get(id), schemaVersion: 1, ...mergeItem(blankItem(), patch), ownership: { type: 'personal', ownerId: user.id }, archived: archived === true,
          createdAt: typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : now, updatedAt: now, history: [...hist, { date: now.slice(0, 10), event: 'imported', reason: '' }] });
        counts.items++;
      }
    });
    await audit.record({ actorId: user.id, action: 'inventory.import', meta: counts, ip });
    return reply(201, { imported: counts });
  }, { bodyLimit: 5 * 1024 * 1024 });

  // ---- AI tools (read-only). The executor has already checked app state + permission; user comes from the session. ----
  const brief = (i) => ({ id: i.id, name: i.identity.name, status: STATUSES[i.status.state], tags: i.identity.tags, brand: i.identification.brand, model: i.identification.model,
    price: i.acquisition.price, currency: i.acquisition.currency, archived: i.archived });
  const tools = s.aiTools;
  tools?.registerApp('inventory', 'inventory.search', {
    parameters: { properties: { query: { type: 'string', maxLength: 100 }, status: { type: 'string', enum: Object.keys(STATUSES) }, tag: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
    handler: async (a, { user }) => { const r = await queryItems(user, (k) => (k === 'q' ? a.query : k === 'limit' ? String(a.limit || 10) : a[k]) || ''); return { total: r.total, items: r.items.map(brief) }; },
  });
  tools?.registerApp('inventory', 'inventory.getItem', {
    parameters: { required: ['id'], properties: { id: { type: 'string', maxLength: 100 } } },
    handler: async ({ id }, { user }) => { const i = await own(items, id, user); return { ...brief(i), description: i.identity.description, condition: CONDITIONS[i.condition.state], notes: i.notes, history: i.history.slice(-10) }; },
  });
  tools?.registerApp('inventory', 'inventory.getStatistics', { parameters: { properties: {} }, handler: async (_a, { user }) => summaryStats(user) });

  // ---- report provider (declared in manifest.reports) ----
  s.reports?.registerApp('inventory', 'inventory-overview', {
    handler: async ({ user, range, filters }) => {
      const allCats = await mine(cats, user), catName = new Map(allCats.map((c) => [c.id, c.name]));
      let list = (await mine(items, user)).filter((i) => !i.archived);
      const sections = [];
      if (filters.category) {
        const ids = allCats.filter((c) => c.name.toLowerCase() === filters.category.toLowerCase()).map((c) => c.id);
        if (!ids.length) sections.push({ heading: 'Filter', text: `You have no category named "${filters.category}", so no items matched.` });
        list = list.filter((i) => ids.includes(i.identity.categoryId));
      }
      if (filters.status) list = list.filter((i) => i.status.state === filters.status);
      const inRange = (d) => d >= range.from && d <= range.to;
      const events = list.flatMap((i) => i.history.filter((h) => inRange(h.date) && !['created', 'imported'].includes(h.event)).map((h) => ({ item: i.identity.name, ...h })))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const count = (ev) => events.filter((e) => e.event === ev).length;
      sections.push({ heading: 'Current overview', stats: statsOf(list).stats });
      sections.push({ heading: `Activity (${range.label})`, stats: [{ label: 'Items added', value: list.filter((i) => inRange(i.createdAt.slice(0, 10))).length },
        { label: 'Status changes', value: count('status_changed') }, { label: 'Moves', value: count('moved') }, { label: 'Notes', value: count('note') }],
        table: { columns: ['Date', 'Item', 'Event', 'Detail'], rows: events.slice(0, 30).map((e) => [e.date, e.item, e.event.replace(/_/g, ' '), e.from || e.to ? `${e.from ?? 'none'} to ${e.to ?? 'none'}` : e.reason || '']) } });
      sections.push({ heading: 'Needs attention', table: { columns: ['Item', 'Status', 'Reason'], rows: list.filter((i) => ATTENTION.includes(i.status.state)).map((i) => [i.identity.name, STATUSES[i.status.state], i.status.reason || '']) } });
      const byCat = new Map(); for (const i of list) { const k = catName.get(i.identity.categoryId) || 'No category'; byCat.set(k, (byCat.get(k) || 0) + 1); }
      sections.push({ heading: 'By category', table: { columns: ['Category', 'Items'], rows: [...byCat].sort((a, b) => b[1] - a[1]) } });
      return { title: 'Inventory overview', sections };
    },
  });
}
