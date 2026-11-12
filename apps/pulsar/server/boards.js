// Pulsar Boards API. Loaded by server/index.js. Routes: /api/apps/pulsar/boards/*
// Data: pulsar_boards (one doc per board), pulsar_board_items (ONE DOC PER OBJECT so saves are small deltas),
// pulsar_board_versions (history snapshots, pruned). Everything is private to the owner.
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { v, allowKeys } from '../../../shared/validate.js';
import { notFound, badRequest, conflict, HttpError } from '../../../shared/errors.js';
import { newId } from '../../../shared/ids.js';
import { reply } from '../../../http/http.js';
import { sanitizeRich } from '../lib/boards/rich.js';

const P = '/api/apps/pulsar';
export const TYPES = ['text', 'sticky', 'image', 'file', 'link', 'shape', 'frame', 'draw', 'connector', 'resource'];
const SHAPES = ['rect', 'rrect', 'circle', 'ellipse', 'diamond', 'triangle', 'arrow', 'line'];
const ROUTES = ['straight', 'curve', 'elbow', 'free'], ARROWS = ['none', 'triangle', 'open', 'diamond', 'dot'], DASH = ['solid', 'dashed', 'dotted'], SIDES = ['auto', 'top', 'right', 'bottom', 'left'];
const REF_TYPES = ['page', 'collection', 'database', 'entry', 'journal', 'board'];
const COLOR_KEYS = ['color', 'bg', 'border', 'fill', 'stroke'];
const STYLE_KEYS = ['font', 'size', 'bold', 'italic', 'underline', 'align', 'valign', 'color', 'bg', 'border', 'bw', 'pad', 'radius', 'fill', 'stroke', 'sw', 'opacity', 'shadow', 'lh'];
export const MAX_ITEMS = 20000, MAX_ITEM_BYTES = 400 * 1024, MAX_PTS = 30000;
const COLOR = /^(#[0-9a-f]{6}([0-9a-f]{2})?|transparent|none)$/i;
const num = (x, lo, hi, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
const s = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const bool = (x) => x === true;
const oidOk = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(x);
const pt = (p) => ({ x: num(p?.x, -1e7, 1e7), y: num(p?.y, -1e7, 1e7) });
const httpUrl = (x, max = 2000) => { try { const u = new URL(String(x)); return (u.protocol === 'https:' || u.protocol === 'http:') && String(x).length <= max ? u.href : ''; } catch { return ''; } };

// ---- link-preview safety: never connect to private / loopback / link-local addresses (SSRF), pinned at connect time ----
export function isBlockedAddress(ip) {
  const f = isIP(ip); if (!f) return true;
  if (f === 4) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224; }
  const l = ip.toLowerCase(); if (l === '::' || l === '::1') return true; const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); if (m) return isBlockedAddress(m[1]);
  return /^(fc|fd|fe[89ab])/.test(l) || l.startsWith('ff');
}
const safeLookup = (host, opts, cb) => lookup(host, { ...opts, all: true }, (err, addrs) => { if (err) return cb(err); const list = (addrs || []).filter((a) => !isBlockedAddress(a.address)); if (!list.length || list.length !== addrs.length) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' })); if (opts?.all) return cb(null, list); cb(null, list[0].address, list[0].family); });
const meta = (html, base) => {
  const g = (re) => { const m = re.exec(html); return m ? m[1] : ''; }, tag = (names) => { for (const n of names) { const a = g(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i')) || g(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i')); if (a) return a; } return ''; };
  const un = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const abs = (u) => { try { return httpUrl(new URL(u, base).href); } catch { return ''; } };
  const icon = g(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i) || g(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i);
  return { title: un(tag(['og:title', 'twitter:title']) || g(/<title[^>]*>([^<]*)<\/title>/i)).slice(0, 200), description: un(tag(['og:description', 'twitter:description', 'description'])).slice(0, 400), image: abs(tag(['og:image', 'twitter:image'])), favicon: abs(icon || '/favicon.ico') };
};
export { meta as parseMeta };
function fetchPage(url, hops = 0) {
  return new Promise((resolve) => {
    const u = new URL(url), lib = u.protocol === 'https:' ? https : http; let done = false; const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const req = lib.request(u, { method: 'GET', lookup: safeLookup, timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulsarBoards/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); if (hops >= 3) return fin({ ok: false }); const nx = httpUrl(new URL(res.headers.location, u).href); return nx ? fetchPage(nx, hops + 1).then(fin) : fin({ ok: false }); }
      if (res.statusCode !== 200 || !/html/i.test(res.headers['content-type'] || '')) { res.resume(); return fin({ ok: false }); }
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { buf += c; if (buf.length > 300000) { res.destroy(); fin({ ok: true, html: buf, url: u.href }); } }); res.on('end', () => fin({ ok: true, html: buf, url: u.href })); res.on('error', () => fin({ ok: false }));
    });
    req.on('timeout', () => { req.destroy(); fin({ ok: false }); }); req.on('error', () => fin({ ok: false })); req.end();
  });
}

export function registerBoards({ router, s: svc, nodes, can, cloud }) {
  const boards = svc.storage.collection('pulsar_boards', { indexes: ['ownerId'] });
  const items = svc.storage.collection('pulsar_board_items', { indexes: ['boardId'] });
  const vers = svc.storage.collection('pulsar_board_versions', { indexes: ['boardId'] });
  const docId = (bid, oid) => `${bid}_${oid}`;
  function srcOk(src) { if (src === '') return true; if (/^\/api\/apps\/pulsar\/assets\/[A-Za-z0-9_-]+\/file$/.test(src)) return true; try { const u = new URL(src); return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com' && (!cloud.cloudName || u.pathname.startsWith(`/${cloud.cloudName}/`)); } catch { return false; } }
  async function own(id, user) { const b = await boards.get(id); if (!b || b.ownerId !== user.id) throw notFound('Board not found'); return b; }
  const listItems = async (bid) => (await items.find({ where: { boardId: bid }, limit: MAX_ITEMS + 1 })).map((d) => d.data);

  function cleanStyle(st) {
    const o = {}; if (!st || typeof st !== 'object') return o;
    for (const k of STYLE_KEYS) { const x = st[k]; if (x === undefined) continue; if (COLOR_KEYS.includes(k)) { if (typeof x === 'string' && COLOR.test(x)) o[k] = x; } else if (typeof x === 'number') o[k] = num(x, -1000, 1000); else if (typeof x === 'boolean') o[k] = x; else if (typeof x === 'string') o[k] = x.slice(0, 80); }
    return o;
  }
  function cleanItem(r) {
    v.object(r, 'item'); if (!oidOk(r.id)) throw badRequest('Invalid object id'); if (!TYPES.includes(r.type)) throw badRequest(`Unknown object type: ${r.type}`);
    const o = { id: r.id, type: r.type, z: num(r.z, -1e9, 1e12, 1), locked: bool(r.locked), hidden: bool(r.hidden), group: r.group && oidOk(r.group) ? r.group : null };
    if (r.type !== 'connector') { Object.assign(o, { x: num(r.x, -1e7, 1e7), y: num(r.y, -1e7, 1e7), w: num(r.w, 1, 1e6, 100), h: num(r.h, 1, 1e6, 100), rot: num(r.rot, -360, 360) }); }
    if (r.type !== 'draw' && r.type !== 'connector') o.style = cleanStyle(r.style);
    switch (r.type) {
      case 'text': case 'sticky': o.html = sanitizeRich(s(r.html, 60000)); break;
      case 'shape': o.kind = SHAPES.includes(r.kind) ? r.kind : 'rect'; o.html = sanitizeRich(s(r.html, 5000)); if (r.flip) o.flip = true; break;
      case 'frame': o.title = s(r.title, 200); o.color = COLOR.test(r.color || '') ? r.color : '#ff6b1a'; o.order = num(r.order, 0, 1e6, 0); break;
      case 'image': { const src = s(r.src, 700); if (!srcOk(src)) throw badRequest('Image source is not allowed'); o.src = src; if (r.assetId) o.assetId = v.anyId(r.assetId, 'assetId'); o.alt = s(r.alt, 500); o.caption = s(r.caption, 1000); const c = r.crop; o.crop = c && typeof c === 'object' ? { x: num(c.x, 0, 1), y: num(c.y, 0, 1), w: num(c.w, 0.01, 1, 1), h: num(c.h, 0.01, 1, 1) } : null; o.nat = r.nat && r.nat.w ? { w: num(r.nat.w, 1, 1e5), h: num(r.nat.h, 1, 1e5) } : null; o.notes = (Array.isArray(r.notes) ? r.notes : []).slice(0, 50).map((n) => ({ x: num(n?.x, 0, 1), y: num(n?.y, 0, 1), text: s(n?.text, 500) })); break; }
      case 'file': { const src = s(r.src, 700); if (!srcOk(src)) throw badRequest('File source is not allowed'); Object.assign(o, { src, name: s(r.name, 200), size: num(r.size, 0, 1e10), mime: s(r.mime, 100), preview: s(r.preview, 2000) }); if (r.assetId) o.assetId = v.anyId(r.assetId, 'assetId'); break; }
      case 'link': { const u = httpUrl(r.url); if (!u) throw badRequest('Links must be http or https URLs'); Object.assign(o, { url: u, title: s(r.title, 300), description: s(r.description, 500), favicon: httpUrl(r.favicon, 600), image: httpUrl(r.image, 900) }); break; }
      case 'draw': { if (!Array.isArray(r.pts) || r.pts.length > MAX_PTS || r.pts.length % 3) throw badRequest('Invalid stroke'); if (r.pts.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw badRequest('Invalid stroke'); Object.assign(o, { tool: ['pen', 'pencil', 'highlighter'].includes(r.tool) ? r.tool : 'pen', pts: r.pts, color: COLOR.test(r.color || '') ? r.color : '#f2f2f2', size: num(r.size, 0.5, 200, 4), opacity: num(r.opacity, 0.02, 1, 1), vw: num(r.vw, 0.1, 1e6, o.w), vh: num(r.vh, 0.1, 1e6, o.h), pressure: bool(r.pressure) }); break; }
      case 'connector': {
        const end = (e) => (e && typeof e === 'object' && oidOk(e.id) ? { id: e.id, side: SIDES.includes(e.side) ? e.side : 'auto' } : null);
        Object.assign(o, { from: end(r.from), to: end(r.to), p1: r.p1 ? pt(r.p1) : null, p2: r.p2 ? pt(r.p2) : null, route: ROUTES.includes(r.route) ? r.route : 'curve', pts: (Array.isArray(r.pts) ? r.pts : []).slice(0, 200).map(pt), mid: num(r.mid, 0, 1, 0.5), color: COLOR.test(r.color || '') ? r.color : '#a6a6a6', sw: num(r.sw, 0.5, 40, 2), dash: DASH.includes(r.dash) ? r.dash : 'solid', startArrow: ARROWS.includes(r.startArrow) ? r.startArrow : 'none', endArrow: ARROWS.includes(r.endArrow) ? r.endArrow : 'triangle', opacity: num(r.opacity, 0.05, 1, 1), label: s(r.label, 200), labelKind: s(r.labelKind, 30) });
        if (!o.from && !o.p1) o.p1 = { x: 0, y: 0 }; if (!o.to && !o.p2) o.p2 = { x: 0, y: 0 }; break; }
      case 'resource': { const ref = r.ref; if (!ref || !REF_TYPES.includes(ref.type) || !oidOk(ref.id)) throw badRequest('Invalid resource reference'); o.ref = { type: ref.type, id: ref.id }; o.mode = r.mode === 'snapshot' ? 'snapshot' : 'live'; o.view = r.view === 'expanded' ? 'expanded' : 'compact';
        const sel = r.sel && typeof r.sel === 'object' ? r.sel : {}; o.sel = { records: (Array.isArray(sel.records) ? sel.records : []).filter(oidOk).slice(0, 100), props: (Array.isArray(sel.props) ? sel.props : []).filter(oidOk).slice(0, 40) };
        if (r.snap && typeof r.snap === 'object') { const j = JSON.stringify(r.snap); if (j.length > 60000) throw badRequest('Snapshot too large'); o.snap = JSON.parse(j); o.snapAt = s(r.snapAt, 40); } break; }
      default: break;
    }
    if (JSON.stringify(o).length > MAX_ITEM_BYTES) throw badRequest('Object is too large');
    return o;
  }
  const cleanMeta = (b, cur = {}) => {
    const o = {}; if ('title' in b) o.title = v.string(b.title ?? '', 'title', { min: 0, max: 200 }) || 'Untitled board'; if ('description' in b) o.description = v.string(b.description ?? '', 'description', { max: 1000, trim: false });
    if ('cover' in b) { const c = s(b.cover, 600); o.cover = srcOk(c) || /^grad:[a-z0-9-]+$/.test(c) ? c : ''; } if ('favorite' in b) o.favorite = bool(b.favorite); if ('archived' in b) o.archived = bool(b.archived);
    if ('folder' in b) o.folder = v.string(b.folder ?? '', 'folder', { max: 60 }); if ('icon' in b) o.icon = s(b.icon, 24);
    if ('settings' in b) { const st = b.settings || {}; o.settings = { snap: st.snap !== false, grid: [0, 8, 16, 24, 32, 64].includes(st.grid) ? st.grid : 16, bg: ['dots', 'lines', 'none'].includes(st.bg) ? st.bg : 'dots' }; }
    if ('viewport' in b && b.viewport) o.viewport = { x: num(b.viewport.x, -1e8, 1e8), y: num(b.viewport.y, -1e8, 1e8), z: num(b.viewport.z, 0.02, 8, 1) }; return { ...cur, ...o };
  };
  const pub = (b) => { const { ops, lastSid, ...r } = b; return r; };

  // ---- history ----
  async function snapshot(b, label, auto) {
    const list = await listItems(b.id); if (!list.length && auto) return null; const data = JSON.stringify(list); if (data.length > 3 * 1024 * 1024) return null;
    const ver = await vers.insert({ id: newId('bv'), boardId: b.id, ownerId: b.ownerId, label: s(label, 80), auto, itemCount: list.length, bytes: data.length, items: list });
    const all = (await vers.find({ where: { boardId: b.id }, limit: 500 })).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    for (const kind of [true, false]) { const mine = all.filter((x) => !!x.auto === kind); for (const old of mine.slice(kind ? 20 : 30)) await vers.delete(old.id); }
    return ver;
  }
  const verMeta = ({ items: _i, ...m }) => m;

  // ---- boards ----
  router.add('GET', `${P}/boards`, async ({ user, query }) => {
    await can(user, 'page.read'); const arch = query.get('archived') === '1';
    const all = (await boards.find({ where: { ownerId: user.id }, limit: 5000 })).filter((b) => !!b.archived === arch);
    return { boards: all.map(pub).sort((a, b) => (b.openedAt || b.updatedAt || '').localeCompare(a.openedAt || a.updatedAt || '')) };
  });
  router.add('POST', `${P}/boards`, async ({ user, body }) => {
    await can(user, 'page.write'); const b = allowKeys(v.object(body), ['id', 'title', 'description', 'cover', 'favorite', 'folder', 'icon', 'settings', 'viewport', 'items', 'archived']);
    if ((await boards.count({ ownerId: user.id })) >= 2000) throw badRequest('Board limit reached');
    if (b.id !== undefined) { if (!/^bd_[a-z0-9]{6,40}$/.test(String(b.id))) throw badRequest('Invalid id'); const ex = await boards.get(b.id); if (ex) { if (ex.ownerId !== user.id) throw badRequest('Invalid id'); return { board: pub(ex), existed: true }; } }
    const list = Array.isArray(b.items) ? b.items : []; if (list.length > 3000) throw badRequest('Send at most 3000 objects when creating a board; add the rest with /ops');
    const clean = list.map(cleanItem); const seen = new Set(); for (const c of clean) { if (seen.has(c.id)) throw badRequest('Duplicate object id'); seen.add(c.id); }
    const base = { id: b.id || newId('bd'), ownerId: user.id, title: 'Untitled board', description: '', cover: '', favorite: false, archived: false, folder: '', icon: '', settings: { snap: true, grid: 16, bg: 'dots' }, viewport: null, rev: 1, itemCount: clean.length, openedAt: new Date().toISOString(), ops: [], schemaVersion: 1 };
    const doc = cleanMeta(b, base); doc.rev = 1; doc.itemCount = clean.length;
    await svc.storage.transaction(async (st) => { await st.collection('pulsar_boards').insert(doc); const ic = st.collection('pulsar_board_items'); for (const c of clean) await ic.upsert({ id: docId(doc.id, c.id), boardId: doc.id, ownerId: user.id, data: c }); });
    return reply(201, { board: pub(await boards.get(doc.id)) });
  }, { bodyLimit: 4 * 1024 * 1024 });

  router.add('POST', `${P}/boards/resolve`, async ({ user, body }) => { // summaries of Pulsar things for cards on a board (read only)
    await can(user, 'page.read'); const b = allowKeys(v.object(body), ['refs']); if (!Array.isArray(b.refs) || b.refs.length > 100) throw badRequest('refs must be an array of at most 100 items');
    const out = {}, plain = (n, k) => (n.plain || '').slice(0, k), firstImg = (n) => (n.blocks || []).find((x) => x.type === 'image')?.src || '';
    for (const r of b.refs) {
      if (!r || !REF_TYPES.includes(r.type) || !oidOk(r.id)) continue; const key = `${r.type}:${r.id}`;
      if (r.type === 'board') { const bd = await boards.get(r.id); out[key] = !bd || bd.ownerId !== user.id ? { state: 'missing' } : bd.archived ? { state: 'ok', archived: true, kind: 'board', id: bd.id, title: bd.title, description: bd.description, cover: bd.cover, itemCount: bd.itemCount, updatedAt: bd.updatedAt } : { state: 'ok', kind: 'board', id: bd.id, title: bd.title, description: bd.description, cover: bd.cover, itemCount: bd.itemCount, updatedAt: bd.updatedAt }; continue; }
      const n = await nodes.get(r.id); if (!n || n.ownerId !== user.id) { out[key] = { state: 'missing' }; continue; } if (n.trashedAt) { out[key] = { state: 'trashed', title: n.title }; continue; }
      const sum = { state: 'ok', kind: n.journalDate ? 'journal' : n.kind, id: n.id, title: n.title, icon: n.icon, cover: n.cover, tags: n.tags || [], updatedAt: n.updatedAt, journalDate: n.journalDate, plain: plain(n, 500), image: firstImg(n) };
      if (n.kind === 'collection' || n.kind === 'database') { const kids = (await nodes.find({ where: { ownerId: user.id, parentId: n.id }, limit: 300 })).filter((k) => !k.trashedAt && k.kind !== 'entry'); sum.childCount = kids.length; sum.children = kids.sort((a, c) => (a.order || 0) - (c.order || 0)).slice(0, 12).map((k) => ({ id: k.id, title: k.title, icon: k.icon, kind: k.kind })); }
      if (n.kind === 'database') { const rows = (await nodes.find({ where: { ownerId: user.id, dbId: n.id }, limit: 500 })).filter((k) => !k.trashedAt); sum.props = (n.schema?.props || []).slice(0, 40).map((p) => ({ id: p.id, name: p.name, type: p.type, options: (p.options || []).slice(0, 60) })); sum.rowCount = rows.length; sum.rows = rows.sort((a, c) => (a.order || 0) - (c.order || 0)).slice(0, 60).map((k) => ({ id: k.id, title: k.title, props: k.props || {} })); }
      out[key] = sum;
    }
    return { results: out };
  });
  router.add('POST', `${P}/boards/link-preview`, async ({ user, body }) => {
    await can(user, 'page.read'); const b = allowKeys(v.object(body), ['url']); const url = httpUrl(b.url); if (!url) throw badRequest('Enter an http or https URL');
    const u = new URL(url); const r = await fetchPage(u.href).catch(() => ({ ok: false }));
    if (!r.ok) return { ok: false, url: u.href, title: u.hostname.replace(/^www\./, ''), favicon: '', description: '', image: '' };
    return { ok: true, url: u.href, ...meta(r.html, r.url) };
  });

  router.add('GET', `${P}/boards/:id`, async ({ user, params }) => { await can(user, 'page.read'); const b = await own(params.id, user); await boards.update(b.id, { openedAt: new Date().toISOString() }); return { board: pub({ ...b }) }; });
  router.add('GET', `${P}/boards/:id/items`, async ({ user, params, query }) => {
    await can(user, 'page.read'); await own(params.id, user); const off = Math.max(0, parseInt(query.get('offset') || '0', 10) || 0), lim = Math.min(2000, Math.max(1, parseInt(query.get('limit') || '1500', 10) || 1500));
    const all = await items.find({ where: { boardId: params.id }, orderBy: { field: 'id', dir: 'asc' }, limit: lim, offset: off }); return { items: all.map((d) => d.data), next: all.length === lim ? off + lim : null };
  });
  router.add('PATCH', `${P}/boards/:id`, async ({ user, params, body }) => {
    await can(user, 'page.write'); const b = await own(params.id, user); const x = allowKeys(v.object(body), ['title', 'description', 'cover', 'favorite', 'archived', 'folder', 'icon', 'settings', 'viewport']);
    const doc = cleanMeta(x, b); const patch = {}; for (const k of ['title', 'description', 'cover', 'favorite', 'archived', 'folder', 'icon', 'settings', 'viewport']) if (k in x) patch[k] = doc[k];
    return { board: pub(await boards.update(b.id, patch)) };
  });
  router.add('DELETE', `${P}/boards/:id`, async ({ user, params }) => {
    await can(user, 'page.delete'); const b = await own(params.id, user);
    await svc.storage.transaction(async (st) => { await st.collection('pulsar_board_items').deleteWhere({ boardId: b.id }); await st.collection('pulsar_board_versions').deleteWhere({ boardId: b.id }); await st.collection('pulsar_boards').delete(b.id); });
    return { ok: true };
  });

  router.add('POST', `${P}/boards/:id/ops`, async ({ user, params, body }) => {
    await can(user, 'page.write'); const b = await own(params.id, user); const x = allowKeys(v.object(body), ['opId', 'sid', 'baseRev', 'force', 'upsert', 'remove', 'viewport']);
    const opId = v.string(x.opId ?? '', 'opId', { min: 6, max: 60 }); if ((b.ops || []).includes(opId)) return { ok: true, rev: b.rev, itemCount: b.itemCount, duplicate: true };
    if (Number.isInteger(x.baseRev) && x.baseRev !== b.rev && b.lastSid && b.lastSid !== x.sid && !x.force) return reply(409, { error: { code: 'conflict', message: 'This board was changed in another tab or device.' }, rev: b.rev });
    const up = Array.isArray(x.upsert) ? x.upsert : [], rm = Array.isArray(x.remove) ? x.remove : []; if (up.length > 600 || rm.length > 3000) throw badRequest('Too many changes in one request');
    const clean = up.map(cleanItem), seen = new Set(); for (const c of clean) { if (seen.has(c.id)) throw badRequest('Duplicate object id'); seen.add(c.id); } for (const id of rm) if (!oidOk(id)) throw badRequest('Invalid object id');
    let count = b.itemCount || 0; const lastAuto = b.lastSnapAt || ''; const needSnap = (clean.length || rm.length) && (!lastAuto || Date.now() - Date.parse(lastAuto) > 10 * 60 * 1000);
    if (needSnap) await snapshot(b, 'Auto-saved', true).catch(() => {});
    await svc.storage.transaction(async (st) => { const ic = st.collection('pulsar_board_items');
      for (const id of rm) { if (await ic.delete(docId(b.id, id))) count--; }
      for (const c of clean) { const had = await ic.get(docId(b.id, c.id)); if (!had) { if (count >= MAX_ITEMS) throw badRequest('This board has reached the object limit'); count++; } await ic.upsert({ id: docId(b.id, c.id), boardId: b.id, ownerId: user.id, data: c }); } });
    const patch = { rev: b.rev + 1, itemCount: Math.max(0, count), ops: [...(b.ops || []).slice(-29), opId], lastSid: s(x.sid, 40), ...(needSnap ? { lastSnapAt: new Date().toISOString() } : {}) };
    if (x.viewport) patch.viewport = cleanMeta({ viewport: x.viewport }).viewport;
    const nb = await boards.update(b.id, patch); return { ok: true, rev: nb.rev, itemCount: nb.itemCount };
  }, { bodyLimit: 4 * 1024 * 1024 });

  router.add('POST', `${P}/boards/:id/duplicate`, async ({ user, params }) => {
    await can(user, 'page.write'); const b = await own(params.id, user); const list = await items.find({ where: { boardId: b.id }, limit: MAX_ITEMS + 1 }); const nid = newId('bd'); const { id, ops, lastSid, lastSnapAt, ...rest } = b;
    await svc.storage.transaction(async (st) => { await st.collection('pulsar_boards').insert({ ...rest, id: nid, title: `Copy of ${b.title}`.slice(0, 200), favorite: false, rev: 1, ops: [], openedAt: new Date().toISOString() }); const ic = st.collection('pulsar_board_items'); for (const d of list) await ic.insert({ id: docId(nid, d.data.id), boardId: nid, ownerId: user.id, data: d.data }); });
    return reply(201, { board: pub(await boards.get(nid)) });
  });

  router.add('GET', `${P}/boards/:id/versions`, async ({ user, params }) => { await can(user, 'page.read'); await own(params.id, user); return { versions: (await vers.find({ where: { boardId: params.id }, limit: 200 })).sort((a, c) => c.createdAt.localeCompare(a.createdAt)).map(verMeta) }; });
  router.add('POST', `${P}/boards/:id/versions`, async ({ user, params, body }) => { await can(user, 'page.write'); const b = await own(params.id, user); const x = allowKeys(v.object(body || {}), ['label']); const ver = await snapshot(b, x.label || 'Saved version', false); if (!ver) throw badRequest('This board is too large to keep a version of'); return reply(201, { version: verMeta(ver) }); });
  router.add('GET', `${P}/boards/:id/versions/:vid`, async ({ user, params }) => { await can(user, 'page.read'); await own(params.id, user); const ver = await vers.get(params.vid); if (!ver || ver.boardId !== params.id) throw notFound('Version not found'); return { version: verMeta(ver), items: ver.items }; }, { });
  router.add('POST', `${P}/boards/:id/versions/:vid/restore`, async ({ user, params, body }) => {
    await can(user, 'page.write'); const b = await own(params.id, user); const x = allowKeys(v.object(body || {}), ['mode']), mode = v.enum(x.mode || 'all', 'mode', ['all', 'deleted']); const ver = await vers.get(params.vid); if (!ver || ver.boardId !== b.id) throw notFound('Version not found');
    await snapshot(b, 'Before restore', true).catch(() => {}); const cur = new Set((await items.find({ where: { boardId: b.id }, limit: MAX_ITEMS + 1 })).map((d) => d.data.id)); const keep = new Set(ver.items.map((i) => i.id)); let count = 0;
    await svc.storage.transaction(async (st) => { const ic = st.collection('pulsar_board_items');
      if (mode === 'all') for (const id of cur) if (!keep.has(id)) await ic.delete(docId(b.id, id));
      for (const it of ver.items) { if (mode === 'deleted' && cur.has(it.id)) continue; await ic.upsert({ id: docId(b.id, it.id), boardId: b.id, ownerId: user.id, data: cleanItem(it) }); count++; } });
    const n = await items.count({ boardId: b.id }); const nb = await boards.update(b.id, { rev: b.rev + 1, itemCount: n, lastSid: '', ops: [] }); return { ok: true, restored: count, rev: nb.rev, itemCount: n };
  }, { });
}
