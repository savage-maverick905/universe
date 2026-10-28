// Pulsar offline layer. While online it remembers what the server returns (page list, every page, settings).
// While offline it answers from that copy and keeps your edits and new pages in a queue on this device,
// then sends them to the server in order as soon as the connection is back.
// Data is stored in this browser's IndexedDB. The app lock is a screen cover, not encryption.
import { blocksPlain } from './inline.js';

const strip = ({ blocks, plain, ...m }) => ({ ...m, blockCount: (blocks || []).length });
const offlineErr = (msg = 'You are offline. This needs a connection.') => Object.assign(new Error(msg), { offline: true });
const rid = () => `pg_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;

// ---- tiny IndexedDB key/value store (silently does nothing if the browser blocks it) ----
let dbp;
const open = () => (dbp ||= new Promise((res, rej) => { try { const r = indexedDB.open('pulsar-offline', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
async function tx(mode, fn) { try { const d = await open(); return await new Promise((res, rej) => { const t = d.transaction('kv', mode); const out = fn(t.objectStore('kv')); t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); } catch { return undefined; } }
const get = (k) => tx('readonly', (s) => s.get(k));
const set = (k, v) => tx('readwrite', (s) => s.put(v, k));
const clearAll = () => tx('readwrite', (s) => s.clear());

let queue = null, userId = null, syncing = false, fetcher = null;
const emit = (type, detail = {}) => window.dispatchEvent(new CustomEvent(type, { detail }));
const saveQ = () => set('queue', queue);
export const pending = () => queue?.length || 0;

export async function init(uid, rawFetch) {
  fetcher = rawFetch;
  const prev = localStorage.getItem('pulsar:uid');
  if (prev && prev !== uid) { await clearAll(); queue = []; ['pulsar:me'].forEach((k) => localStorage.removeItem(k)); }
  localStorage.setItem('pulsar:uid', uid); userId = uid;
  queue = (await get('queue')) || [];
}
export const rememberMe = (me) => { try { localStorage.setItem('pulsar:me', JSON.stringify(me)); } catch { /* full */ } };
export const cachedMe = () => { try { return JSON.parse(localStorage.getItem('pulsar:me') || 'null'); } catch { return null; } };
export async function forget() { if (!pending()) { await clearAll(); localStorage.removeItem('pulsar:me'); localStorage.removeItem('pulsar:uid'); } }

// ---- remember what the server said ----
async function listPut(fn) { const l = (await get('list')) || []; fn(l); await set('list', l); }
const upsertMeta = (l, n) => { const m = strip(n), i = l.findIndex((x) => x.id === n.id); if (i < 0) l.push(m); else l[i] = { ...l[i], ...m }; };
export async function remember(method, path, res) {
  const [p, qs] = path.split('?'); const m = p.match(/^\/nodes\/([\w-]+)$/);
  if (method === 'GET') {
    if (p === '/nodes' && !qs) await set('list', res.nodes);
    else if (m) await set(`n:${m[1]}`, res.node);
    else if (p === '/meta' || p === '/settings') await set(p, res);
  } else if (method === 'POST' && p === '/nodes' && res.node) { await set(`n:${res.node.id}`, res.node); await listPut((l) => upsertMeta(l, res.node)); }
  else if (method === 'PATCH' && m && res.node) { await set(`n:${m[1]}`, res.node); await listPut((l) => upsertMeta(l, res.node)); }
  else if (method === 'PUT' && p === '/settings') await set('/settings', res);
}

// ---- answer from the saved copy ----
async function localSearch(qs) {
  const p = new URLSearchParams(qs || ''), q = (p.get('q') || '').trim().toLowerCase(), terms = q.split(/\s+/).filter(Boolean), list = (await get('list')) || [];
  const tag = p.get('tag'), fav = p.get('favorite') === '1', kind = p.get('kind'), within = p.get('within'), since = p.get('since'), jonly = p.get('journal') === '1';
  let scope = null; if (within) { scope = new Set([within]); let grew = true; while (grew) { grew = false; for (const n of list) if (n.parentId && scope.has(n.parentId) && !scope.has(n.id)) { scope.add(n.id); grew = true; } } }
  const out = [];
  for (const m of list) {
    if (m.trashedAt || (tag && !(m.tags || []).includes(tag)) || (fav && !m.favorite) || (kind && m.kind !== kind) || (scope && !scope.has(m.id)) || (since && (m.updatedAt || '') < since) || (jonly && !m.journalDate)) continue;
    const full = await get(`n:${m.id}`), plain = full?.plain || '', title = (m.title || '').toLowerCase(), tags = (m.tags || []).join(' ').toLowerCase(), pl = plain.toLowerCase(); let score = 0, snip = '';
    if (terms.length) { for (const t of terms) { if (title.includes(t)) score += 10; else if (tags.includes(t)) score += 4; const i = pl.indexOf(t); if (i >= 0) { score += 2; if (!snip) snip = plain.slice(Math.max(0, i - 40), i + 100).replace(/\s+/g, ' '); } } if (!score) continue; }
    out.push({ ...m, snippet: snip || plain.slice(0, 120), score });
  }
  out.sort((a, b) => b.score - a.score || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { nodes: out.slice(0, 100), total: out.length };
}

async function queueCreate(body) {
  const now = new Date().toISOString(), id = body.id || rid(), kind = body.kind || 'page';
  const node = { id, ownerId: userId, kind, parentId: body.parentId || null, dbId: kind === 'entry' ? body.parentId || null : null, title: body.title ?? 'Untitled', icon: body.icon || '', cover: body.cover || '', tags: body.tags || [], favorite: !!body.favorite, journalDate: body.journalDate || null, trashedAt: null, trashRoot: null, order: Number.isFinite(body.order) ? body.order : Date.now(), blocks: body.blocks || [], props: body.props || {}, schema: kind === 'database' ? body.schema || null : null, rev: 1, createdAt: now, updatedAt: now };
  node.plain = blocksPlain(node.blocks);
  await set(`n:${id}`, node); await listPut((l) => upsertMeta(l, node));
  queue.push({ k: 'c', method: 'POST', path: '/nodes', node: id, body: { ...body, id } }); await saveQ(); emit('pulsar:queue');
  return { node, queued: true };
}
async function queuePatch(id, body) {
  const { rev, ...patch } = body, now = new Date().toISOString(); let n = await get(`n:${id}`);
  if (n) { n = { ...n, ...patch, updatedAt: now }; if ('blocks' in patch) n.plain = blocksPlain(patch.blocks); await set(`n:${id}`, n); }
  await listPut((l) => { const i = l.findIndex((x) => x.id === id); if (i >= 0) { const { blocks, ...rest } = patch; l[i] = { ...l[i], ...rest, updatedAt: now, ...(blocks ? { blockCount: blocks.length } : {}) }; } });
  const mine = queue.find((o) => o.node === id && (o.k === 'c' || o.k === 'p'));
  if (mine) mine.body = { ...mine.body, ...patch }; else queue.push({ k: 'p', method: 'PATCH', path: `/nodes/${id}`, node: id, body: { ...patch, rev } });
  await saveQ(); emit('pulsar:queue');
  const meta = ((await get('list')) || []).find((x) => x.id === id);
  return { node: n || meta || { id, ...patch }, queued: true };
}
async function queueSettings(body) {
  const cur = (await get('/settings')) || { settings: {} }; const next = { settings: { ...cur.settings, ...body } }; await set('/settings', next);
  const mine = queue.find((o) => o.k === 's'); if (mine) mine.body = { ...mine.body, ...body }; else queue.push({ k: 's', method: 'PUT', path: '/settings', body });
  await saveQ(); emit('pulsar:queue'); return { ...next, queued: true };
}

export async function call(method, path, body) {
  queue ||= (await get('queue')) || [];
  const [p, qs] = path.split('?'); const m = p.match(/^\/nodes\/([\w-]+)$/);
  if (method === 'GET') {
    if (p === '/nodes') { if (new URLSearchParams(qs || '').get('trashed') === '1') throw offlineErr('The trash needs a connection.'); const l = await get('list'); if (!l) throw offlineErr('Open Pulsar once while online so your pages can be saved for offline use.'); return { nodes: l }; }
    if (m) { const n = await get(`n:${m[1]}`); if (!n) throw offlineErr('This page has not been saved for offline use yet. Open it once while online.'); return { node: n }; }
    if (p === '/meta' || p === '/settings') { const r = await get(p); if (r) return r; if (p === '/settings') return { settings: {} }; throw offlineErr('Open Pulsar once while online first.'); }
    if (p === '/search') return localSearch(qs);
    if (/\/backlinks$/.test(p)) return { nodes: [] };
  } else if (method === 'POST' && p === '/nodes') return queueCreate(body || {});
  else if (method === 'PATCH' && m) return queuePatch(m[1], body || {});
  else if (method === 'PUT' && p === '/settings') return queueSettings(body || {});
  else if (method === 'POST' && p.startsWith('/journal/')) {
    const d = p.split('/')[2], list = (await get('list')) || [], ex = list.find((n) => n.journalDate === d && !n.trashedAt);
    if (ex) return { node: (await get(`n:${ex.id}`)) || ex, created: false };
    const r = await queueCreate({ kind: 'page', title: body?.title || d, icon: body?.icon || 'book', blocks: body?.blocks || [], journalDate: d }); return { node: r.node, created: true, queued: true };
  }
  throw offlineErr();
}

// ---- send the queue to the server ----
async function runOp(op) {
  try { const r = await fetcher(op.method, op.path, op.body); await after(op, r); return 'done'; }
  catch (e) {
    if (!e.status) return 'wait';                         // still no connection
    if (e.status === 401) return 'wait';                  // signed out: keep everything, try again after sign-in
    if (e.status === 409 && op.k === 'p') {               // changed elsewhere while you were offline: your edit wins
      try { const cur = (await fetcher('GET', op.path)).node; const r = await fetcher('PATCH', op.path, { ...op.body, rev: cur.rev }); await after(op, r); return 'done'; } catch (e2) { return e2.status && e2.status !== 401 ? 'drop' : 'wait'; }
    }
    return 'drop';
  }
}
async function after(op, r) {
  if (op.k === 's') { await set('/settings', r); return; }
  const n = r.node; if (!n) return; await set(`n:${n.id}`, n); await listPut((l) => upsertMeta(l, n)); emit('pulsar:rev', { id: n.id, rev: n.rev });
}
export async function sync() {
  if (syncing || !fetcher || !navigator.onLine) return; queue ||= (await get('queue')) || []; if (!queue.length) return;
  syncing = true; emit('pulsar:sync', { state: 'start' }); let sent = 0, dropped = 0;
  try { for (;;) { const op = queue[0]; if (!op) break; const r = await runOp(op); if (r === 'wait') break; queue.shift(); await saveQ(); r === 'drop' ? dropped++ : sent++; } }
  finally { syncing = false; emit('pulsar:sync', { state: 'end', sent, dropped, left: queue.length }); emit('pulsar:queue'); }
}
let soon; export const syncSoon = () => { clearTimeout(soon); soon = setTimeout(sync, 400); };

// Save every page for offline use (in the background, a few at a time).
export async function prefetch(list, fetchNode) {
  if (!navigator.onLine || pending()) return; const todo = [];
  for (const m of list) { const c = await get(`n:${m.id}`); if (!c || c.rev !== m.rev) todo.push(m.id); }
  let i = 0; await Promise.all([0, 1, 2].map(async () => { while (i < todo.length && navigator.onLine) { const id = todo[i++]; try { await fetchNode(id); } catch { /* skip */ } } }));
}
