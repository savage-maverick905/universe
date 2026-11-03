// Timetables: named weekly plans (School, Work, Gym...). An item is either FIXED ("06:00 to 07:00") or a DURATION
// ("1 hour", "30 min"). Duration items have no clock time of their own: they start when the previous item on that day
// ends (the first one starts at the timetable's "starts at" time). Mixing both in one timetable is fine.
// Everything is resolved to real clock ranges here, so clashes can be found between ANY two timetables.
// Statuses ("done", "skipped"...) are kept per item per date, because a weekly timetable repeats every week.
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest, conflict, notFound } from '../../../shared/errors.js';
import { reply } from '../../../http/http.js';
import { newId, nowIso } from '../../../shared/ids.js';
import { isDate, minutes, weekday } from './dates.js';

export const ITEM_STATUSES = [['done', 'Done'], ['in_progress', 'In progress'], ['partly', 'Partly done'], ['postponed', 'Postponed'], ['skipped', 'Skipped'], ['missed', 'Missed']];
export const ITEM_STATUS_IDS = ITEM_STATUSES.map(([id]) => id);
export const TIMETABLE_LIMITS = { timetables: 30, itemsPerTimetable: 120, tasksPerItem: 50, statusDates: 120 };
const COLORS = ['#FF6B1A', '#3DD68C', '#4DA3FF', '#C084FC', '#F5C84B', '#FF5C7A', '#2DD4BF', '#A3A3A3'];
const strip = ({ ownerId, ...d }) => d;
const time = (x, name) => { if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw badRequest(`${name} must be a time like 14:30`); return x; };
const nullable = (x, fn) => (x === null || x === '' || x === undefined ? null : fn(x));
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function timetableIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), ['name', 'color', 'startTime', 'active']), o = {};
  if (!partial && !('name' in b)) throw badRequest('name is required');
  if ('name' in b) o.name = v.string(b.name, 'name', { min: 1, max: 80 });
  if ('color' in b) { if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color)) throw badRequest('color must look like #FF6B1A'); o.color = b.color.toUpperCase(); }
  if ('startTime' in b) o.startTime = time(b.startTime, 'startTime');
  if ('active' in b) { if (typeof b.active !== 'boolean') throw badRequest('active must be true or false'); o.active = b.active; }
  return o;
}

export function itemIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), ['title', 'days', 'startTime', 'endTime', 'durationMin', 'notes']), o = {};
  if (!partial && !('title' in b)) throw badRequest('title is required');
  if ('title' in b) o.title = v.string(b.title, 'title', { min: 1, max: 120 });
  if ('days' in b) {
    if (!Array.isArray(b.days) || !b.days.length || b.days.length > 7 || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('days must list weekday numbers 0 (Sunday) to 6, at least one');
    o.days = [...new Set(b.days)].sort((a, c) => a - c);
  }
  if ('startTime' in b) o.startTime = nullable(b.startTime, (x) => time(x, 'startTime'));
  if ('endTime' in b) o.endTime = nullable(b.endTime, (x) => time(x, 'endTime'));
  if ('durationMin' in b) o.durationMin = nullable(b.durationMin, (x) => { if (!Number.isInteger(x) || x < 1 || x > 1440) throw badRequest('durationMin must be a whole number of minutes from 1 to 1440'); return x; });
  if ('notes' in b) o.notes = v.string(b.notes, 'notes', { max: 1000 });
  return o;
}

// One clock range per item per weekday it runs on.
export function resolve(tt) {
  const out = [];
  for (let day = 0; day < 7; day++) {
    let cursor = minutes(tt.startTime || '08:00');
    for (const it of tt.items) {
      if (!it.days.includes(day)) continue;
      const start = it.startTime ? minutes(it.startTime) : cursor;
      const raw = it.endTime ? minutes(it.endTime) : start + (it.durationMin || 60);
      cursor = raw;
      out.push({ timetableId: tt.id, timetable: tt.name, color: tt.color, itemId: it.id, title: it.title, day, start: Math.min(start, 1439), end: Math.min(raw, 1440), overflow: raw > 1440 || start >= 1440,
        startTime: hhmm(Math.min(start, 1439)), endTime: hhmm(Math.min(raw, 1440) === 1440 ? 1439 : Math.min(raw, 1440)), durationMin: Math.min(raw, 1440) - Math.min(start, 1439), fixed: !!(it.startTime && it.endTime) });
    }
  }
  return out;
}

// Every pair of items whose clock ranges overlap on the same weekday. `cross` is true when they belong to different timetables.
export function findClashes(timetables, { onlyDay = null } = {}) {
  const all = timetables.filter((t) => t.active !== false).flatMap(resolve).filter((r) => (onlyDay == null || r.day === onlyDay));
  const out = [], mark = new Set();
  for (let d = 0; d < 7; d++) {
    const list = all.filter((r) => r.day === d).sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
      const a = list[i], b = list[j], from = Math.max(a.start, b.start), to = Math.min(a.end, b.end);
      if (to <= from) continue;
      mark.add(`${a.timetableId}|${a.itemId}|${d}`); mark.add(`${b.timetableId}|${b.itemId}|${d}`);
      if (out.length < 300) out.push({ day: d, cross: a.timetableId !== b.timetableId, from: hhmm(from), to: hhmm(to === 1440 ? 1439 : to), minutes: to - from,
        a: { timetableId: a.timetableId, timetable: a.timetable, itemId: a.itemId, title: a.title, startTime: a.startTime, endTime: a.endTime },
        b: { timetableId: b.timetableId, timetable: b.timetable, itemId: b.itemId, title: b.title, startTime: b.startTime, endTime: b.endTime } });
    }
  }
  return { clashes: out, marked: mark };
}

export function makeTimetables(s, core) {
  const col = core.cols.timetables, tasks = core.cols.tasks;
  const mine = (user) => col.find({ where: { ownerId: user.id }, limit: 200 });
  const own = async (id, user) => { const d = id ? await col.get(id) : null; if (!d || d.ownerId !== user.id) throw notFound('Timetable not found'); return d; };
  const clean = (t) => ({ ...strip(t), items: t.items.map((i) => ({ ...i })) });
  const view = async (t, user) => { const linked = await linkedTasks(user); return { ...clean(t), items: t.items.map((i) => ({ ...i, linked: linked.get(i.id) || [] })) }; };
  async function linkedTasks(user) {
    const m = new Map();
    for (const t of await tasks.find({ where: { ownerId: user.id }, limit: 20000 })) if (t.timetableItemId && !t.archived) (m.get(t.timetableItemId) || m.set(t.timetableItemId, []).get(t.timetableItemId)).push({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate });
    return m;
  }
  const clashesFor = (list, tt) => { const { clashes } = findClashes(list); return clashes.filter((c) => c.a.timetableId === tt.id || c.b.timetableId === tt.id); };

  async function list(user) {
    const all = await mine(user), { clashes } = findClashes(all), linked = await linkedTasks(user);
    return { timetables: all.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1).map((t) => ({ ...clean(t), items: t.items.map((i) => ({ ...i, linked: linked.get(i.id) || [] })) })), clashes, statuses: ITEM_STATUSES.map(([id, label]) => ({ id, label })) };
  }
  async function create(user, input) {
    if ((await col.count({ ownerId: user.id })) >= TIMETABLE_LIMITS.timetables) throw conflict(`You can have at most ${TIMETABLE_LIMITS.timetables} timetables`, 'limit');
    const n = await col.count({ ownerId: user.id });
    const doc = { color: COLORS[n % COLORS.length], startTime: '08:00', active: true, ...input, items: [], statuses: {} };
    const t = await col.insert({ id: newId('ttb'), ownerId: user.id, ...doc });
    return { timetable: await view(t, user), clashes: [] };
  }
  async function update(user, id, patch) {
    const t = await own(id, user); await col.update(t.id, patch);
    const all = await mine(user); return { timetable: await view(all.find((x) => x.id === id), user), clashes: clashesFor(all, t) };
  }
  async function remove(user, id) {
    const t = await own(id, user);
    await s.storage.transaction(async () => {
      for (const x of await tasks.find({ where: { ownerId: user.id }, limit: 20000 })) if (x.timetableId === t.id) await tasks.update(x.id, { timetableId: null, timetableItemId: null });
      await col.delete(t.id);
    });
    return { ok: true };
  }
  function checkItem(doc) {
    if (doc.endTime && !doc.startTime) throw badRequest('An end time needs a start time');
    if (doc.endTime && doc.startTime && doc.endTime <= doc.startTime) throw badRequest('The end time must be after the start time');
    if (!doc.endTime && !doc.durationMin) throw badRequest('Give a duration (like 45 minutes) or a start and end time');
    if (doc.endTime) doc.durationMin = null; // a fixed range wins; the length is worked out from it
  }
  async function addItem(user, id, input) {
    const t = await own(id, user);
    if (t.items.length >= TIMETABLE_LIMITS.itemsPerTimetable) throw conflict(`A timetable can hold at most ${TIMETABLE_LIMITS.itemsPerTimetable} items`, 'limit');
    const doc = { days: [0, 1, 2, 3, 4, 5, 6], startTime: null, endTime: null, durationMin: null, notes: '', ...input }; checkItem(doc);
    const item = { id: newId('tti'), ...doc, createdAt: nowIso() }; t.items.push(item); await col.update(t.id, { items: t.items });
    const all = await mine(user); return { item: { ...item, linked: [] }, timetable: await view(all.find((x) => x.id === id), user), clashes: clashesFor(all, t) };
  }
  async function updateItem(user, id, itemId, patch) {
    const t = await own(id, user), i = t.items.findIndex((x) => x.id === itemId); if (i < 0) throw notFound('Timetable item not found');
    const doc = { ...t.items[i], ...patch };
    if ('startTime' in patch && !('endTime' in patch) && !patch.startTime) doc.endTime = null;
    checkItem(doc); t.items[i] = doc; await col.update(t.id, { items: t.items });
    const all = await mine(user); return { item: doc, timetable: await view(all.find((x) => x.id === id), user), clashes: clashesFor(all, t) };
  }
  async function moveItem(user, id, itemId, dir) {
    const t = await own(id, user), i = t.items.findIndex((x) => x.id === itemId); if (i < 0) throw notFound('Timetable item not found');
    const j = i + (dir < 0 ? -1 : 1); if (j >= 0 && j < t.items.length) { [t.items[i], t.items[j]] = [t.items[j], t.items[i]]; await col.update(t.id, { items: t.items }); }
    const all = await mine(user); return { timetable: await view(all.find((x) => x.id === id), user), clashes: clashesFor(all, t) };
  }
  async function removeItem(user, id, itemId) {
    const t = await own(id, user); if (!t.items.some((x) => x.id === itemId)) throw notFound('Timetable item not found');
    const items = t.items.filter((x) => x.id !== itemId), statuses = {};
    for (const [d, m] of Object.entries(t.statuses || {})) { const { [itemId]: _gone, ...rest } = m; if (Object.keys(rest).length) statuses[d] = rest; }
    await s.storage.transaction(async () => {
      for (const x of await tasks.find({ where: { ownerId: user.id }, limit: 20000 })) if (x.timetableItemId === itemId) await tasks.update(x.id, { timetableId: null, timetableItemId: null });
      await col.update(t.id, { items, statuses });
    });
    return { ok: true };
  }
  async function setStatus(user, id, itemId, { date, status }) {
    const t = await own(id, user); if (!t.items.some((x) => x.id === itemId)) throw notFound('Timetable item not found');
    if (!isDate(date)) throw badRequest('date must be a date like 2026-11-02');
    if (status !== null && !ITEM_STATUS_IDS.includes(status)) throw badRequest(`status must be one of: ${ITEM_STATUS_IDS.join(', ')}, or null to clear it`);
    const statuses = { ...(t.statuses || {}) }, day = { ...(statuses[date] || {}) };
    if (status === null) delete day[itemId]; else day[itemId] = { status, at: nowIso() };
    if (Object.keys(day).length) statuses[date] = day; else delete statuses[date];
    const dates = Object.keys(statuses).sort(); for (const old of dates.slice(0, Math.max(0, dates.length - TIMETABLE_LIMITS.statusDates))) delete statuses[old];
    await col.update(t.id, { statuses }); return { ok: true, date, itemId, status };
  }
  // Which tasks belong to this item. Sets the whole list: tasks not in it are unlinked.
  async function linkTasks(user, id, itemId, taskIds) {
    const t = await own(id, user); if (!t.items.some((x) => x.id === itemId)) throw notFound('Timetable item not found');
    if (!Array.isArray(taskIds) || taskIds.length > TIMETABLE_LIMITS.tasksPerItem) throw badRequest(`taskIds must be a list of at most ${TIMETABLE_LIMITS.tasksPerItem} task ids`);
    const want = new Set(taskIds.map((x) => v.anyId(x, 'task id')));
    await s.storage.transaction(async () => {
      for (const tid of want) await core.ownTask(tid, user);
      for (const x of await tasks.find({ where: { ownerId: user.id }, limit: 20000 })) {
        if (want.has(x.id)) { if (x.timetableItemId !== itemId) await tasks.update(x.id, { timetableId: t.id, timetableItemId: itemId }); }
        else if (x.timetableItemId === itemId) await tasks.update(x.id, { timetableId: null, timetableItemId: null });
      }
    });
    return { ok: true, linked: (await linkedTasks(user)).get(itemId) || [] };
  }
  // One date, every active timetable together, in time order, with clash flags, statuses and linked tasks.
  async function day(user, date) {
    if (!isDate(date)) throw badRequest('date must be a date like 2026-11-02');
    const all = (await mine(user)).filter((t) => t.active !== false), wd = weekday(date), { marked } = findClashes(all, { onlyDay: wd }), linked = await linkedTasks(user);
    const byId = new Map(all.map((t) => [t.id, t]));
    const items = all.flatMap(resolve).filter((r) => r.day === wd).sort((a, b) => a.start - b.start || a.title.localeCompare(b.title)).map((r) => {
      const it = byId.get(r.timetableId).items.find((x) => x.id === r.itemId), st = byId.get(r.timetableId).statuses?.[date]?.[r.itemId];
      return { ...r, notes: it.notes || '', status: st?.status || null, clash: marked.has(`${r.timetableId}|${r.itemId}|${wd}`), linked: linked.get(r.itemId) || [] };
    });
    return { date, weekday: wd, items, totals: { items: items.length, done: items.filter((i) => i.status === 'done').length, clashes: items.filter((i) => i.clash).length } };
  }
  return { list, create, update, remove, addItem, updateItem, moveItem, removeItem, setStatus, linkTasks, day, clashes: async (user) => findClashes(await mine(user)).clashes, view, own };
}

export function timetableRoutes({ route, tt, opt }) {
  const P = '/timetables';
  route('GET', P, 'task.read', ({ user }) => tt.list(user));
  route('POST', P, 'task.write', async ({ user, body }) => reply(201, await tt.create(user, timetableIn(body))));
  route('GET', '/timetable-day', 'task.read', ({ user, query }) => tt.day(user, query.get('date')));
  route('GET', '/timetable-clashes', 'task.read', async ({ user }) => ({ clashes: await tt.clashes(user) }));
  route('PATCH', `${P}/:id`, 'task.write', ({ user, params, body }) => tt.update(user, params.id, timetableIn(body, { partial: true })));
  route('DELETE', `${P}/:id`, 'task.write', ({ user, params }) => tt.remove(user, params.id));
  route('POST', `${P}/:id/items`, 'task.write', async ({ user, params, body }) => reply(201, await tt.addItem(user, params.id, itemIn(body))));
  route('PATCH', `${P}/:id/items/:itemId`, 'task.write', ({ user, params, body }) => tt.updateItem(user, params.id, params.itemId, itemIn(body, { partial: true })));
  route('DELETE', `${P}/:id/items/:itemId`, 'task.write', ({ user, params }) => tt.removeItem(user, params.id, params.itemId));
  route('POST', `${P}/:id/items/:itemId/move`, 'task.write', ({ user, params, body }) => tt.moveItem(user, params.id, params.itemId, Number(allowKeys(v.object(body), ['dir']).dir) < 0 ? -1 : 1));
  route('PUT', `${P}/:id/items/:itemId/status`, 'task.write', ({ user, params, body }) => { const b = allowKeys(v.object(body), ['date', 'status']); return tt.setStatus(user, params.id, params.itemId, { date: b.date, status: b.status ?? null }); });
  route('PUT', `${P}/:id/items/:itemId/tasks`, 'task.write', ({ user, params, body }) => tt.linkTasks(user, params.id, params.itemId, allowKeys(v.object(body), ['taskIds']).taskIds));
}
