// Pulsar: notes, nested pages, journal, databases, assets. Loaded by core/appLoader.js. Routes: /api/apps/pulsar/*
// Data: pulsar_nodes (pages, collections, databases, entries, journal entries), pulsar_assets (image/file records), pulsar_settings.
import { v, allowKeys } from '../../../shared/validate.js';
import { notFound, badRequest, conflict, HttpError } from '../../../shared/errors.js';
import { newId } from '../../../shared/ids.js';
import { reply } from '../../../http/http.js';
import { sanitizeHtml, blocksPlain, blockLinks } from '../lib/inline.js';

const P = '/api/apps/pulsar';
const KINDS = ['page', 'collection', 'database', 'entry'];
const BLOCKS = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'hr', 'code', 'callout', 'table', 'image', 'gallery', 'pagelink', 'file', 'toc'];
const PROP_TYPES = ['text', 'number', 'checkbox', 'date', 'status', 'select', 'multi_select', 'url', 'relation'];
const IMG_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const FILE_MIME = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/zip', 'application/json', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const MAX_LOCAL = 3 * 1024 * 1024, MAX_NODES = 20000, MAX_BLOCKS = 5000;
const magic = (b, mime) => (mime === 'image/jpeg' ? b[0] === 0xFF && b[1] === 0xD8 : mime === 'image/png' ? b.subarray(0, 4).toString('hex') === '89504e47' : mime === 'image/gif' ? b.subarray(0, 3).toString() === 'GIF' : mime === 'image/webp' ? b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' : true);
const str = (x, name, max, min = 0) => v.string(x ?? '', name, { min, max, trim: false });
const bool = (x) => x === true;
const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);

export function register({ router, services: s }) {
  const nodes = s.storage.collection('pulsar_nodes', { indexes: ['ownerId'] });
  const assets = s.storage.collection('pulsar_assets', { indexes: ['ownerId'] });
  const sets = s.storage.collection('pulsar_settings', { indexes: ['ownerId'] });
  const can = (user, perm) => s.permissions.assert(user, `pulsar.${perm}`);
  const cloud = s.config.cloudinary || {};
  const localOk = s.config.storage?.driver === 'sqlite';
  const mine = (user) => nodes.find({ where: { ownerId: user.id }, limit: MAX_NODES + 1 });
  async function own(id, user) { const n = await nodes.get(id); if (!n || n.ownerId !== user.id) throw notFound('Page not found'); return n; }

  function srcOk(src) {
    if (src === '') return true;
    if (/^\/api\/apps\/pulsar\/assets\/[A-Za-z0-9_-]+\/file$/.test(src)) return true;
    try { const u = new URL(src); return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com' && (!cloud.cloudName || u.pathname.startsWith(`/${cloud.cloudName}/`)); } catch { return false; }
  }
  const img = (i) => { if (!i || typeof i !== 'object') throw badRequest('Invalid image'); if (!srcOk(String(i.src ?? ''))) throw badRequest('Image source is not allowed'); return { src: i.src, assetId: i.assetId ? v.anyId(i.assetId, 'assetId') : undefined, alt: str(i.alt, 'alt', 500) }; };
  function cleanBlock(b) {
    v.object(b, 'block'); if (!BLOCKS.includes(b.type)) throw badRequest(`Unknown block type: ${b.type}`);
    const o = { id: b.id ? v.anyId(b.id, 'block id') : newId('b'), type: b.type };
    if (b.indent) o.indent = int(b.indent, 0, 6, 0);
    if (['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'callout', 'code'].includes(b.type)) o.html = sanitizeHtml(str(b.html, 'html', 200000));
    if (b.type === 'todo') o.checked = bool(b.checked);
    if (b.type === 'code') { o.html = str(b.html, 'html', 200000); o.lang = str(b.lang, 'lang', 30); }
    if (b.type === 'callout') o.icon = str(b.icon, 'icon', 8);
    if (b.type === 'table') { if (!Array.isArray(b.rows) || b.rows.length > 300) throw badRequest('Invalid table'); o.rows = b.rows.map((r) => { if (!Array.isArray(r) || r.length > 20) throw badRequest('Invalid table row'); return r.map((c) => sanitizeHtml(str(c, 'cell', 20000))); }); o.header = b.header !== false; }
    if (b.type === 'image') { Object.assign(o, img(b)); o.w = int(b.w, 10, 100, 100); o.align = ['left', 'center', 'right'].includes(b.align) ? b.align : 'center'; o.caption = sanitizeHtml(str(b.caption, 'caption', 2000)); }
    if (b.type === 'gallery') { if (!Array.isArray(b.imgs) || b.imgs.length > 12) throw badRequest('Invalid image row'); o.imgs = b.imgs.map(img); o.caption = sanitizeHtml(str(b.caption, 'caption', 2000)); }
    if (b.type === 'pagelink') { o.pageId = v.anyId(b.pageId, 'pageId'); o.title = str(b.title, 'title', 200); }
    if (b.type === 'file') { if (!srcOk(String(b.src ?? ''))) throw badRequest('File source is not allowed'); o.src = b.src; o.assetId = b.assetId ? v.anyId(b.assetId, 'assetId') : undefined; o.name = str(b.name, 'name', 200); o.size = int(b.size, 0, 1e9, 0); o.mime = str(b.mime, 'mime', 100); }
    return o;
  }
  const cleanBlocks = (arr) => { if (!Array.isArray(arr) || arr.length > MAX_BLOCKS) throw badRequest(`blocks must be an array of at most ${MAX_BLOCKS} blocks`); const seen = new Set(); return arr.map((b) => { const c = cleanBlock(b); if (seen.has(c.id)) c.id = newId('b'); seen.add(c.id); return c; }); };
  function cleanProp(p) {
    v.object(p, 'property'); return { id: v.anyId(p.id, 'property id'), name: str(p.name, 'property name', 60, 1), type: v.enum(p.type, 'property type', PROP_TYPES),
      options: (Array.isArray(p.options) ? p.options : []).slice(0, 60).map((o) => ({ id: v.anyId(o.id, 'option id'), name: str(o.name, 'option', 60, 1), color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : '#707070' })), relationTo: p.relationTo ? v.anyId(p.relationTo, 'relationTo') : undefined };
  }
  function cleanSchema(sc) {
    v.object(sc, 'schema'); const props = (sc.props || []).slice(0, 40).map(cleanProp);
    const views = (sc.views || []).slice(0, 10).map((w) => ({ id: v.anyId(w.id, 'view id'), name: str(w.name, 'view name', 60, 1), type: v.enum(w.type, 'view type', ['table', 'board', 'calendar']),
      sort: w.sort && w.sort.prop ? { prop: str(w.sort.prop, 'sort', 60), dir: w.sort.dir === 'desc' ? 'desc' : 'asc' } : null,
      filters: (w.filters || []).slice(0, 10).map((f) => ({ prop: str(f.prop, 'filter', 60), op: v.enum(f.op, 'filter op', ['contains', 'is', 'not', 'empty', 'filled', 'checked', 'unchecked']), value: str(f.value, 'filter value', 200) })),
      groupBy: w.groupBy ? str(w.groupBy, 'groupBy', 60) : null, dateProp: w.dateProp ? str(w.dateProp, 'dateProp', 60) : null }));
    return { props, views: views.length ? views : [{ id: 'v_table', name: 'Table', type: 'table', sort: null, filters: [], groupBy: null, dateProp: null }] };
  }
  function cleanValues(pr) {
    v.object(pr, 'props'); const out = {};
    for (const [k, val] of Object.entries(pr).slice(0, 60)) { v.anyId(k, 'property id');
      if (val === null || typeof val === 'boolean') out[k] = val; else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
      else if (typeof val === 'string') out[k] = str(val, 'value', 2000); else if (Array.isArray(val)) out[k] = val.slice(0, 100).map((x) => str(x, 'value', 200)); else throw badRequest('Invalid property value'); }
    return out;
  }
  const date = (x) => { if (x === null || x === undefined || x === '') return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) throw badRequest('journalDate must be YYYY-MM-DD'); return x; };
  const derive = (n) => ({ ...n, plain: blocksPlain(n.blocks || []), links: blockLinks(n.blocks || []) });
  const meta = (n, snippet = 0) => { const { blocks, plain, ...m } = n; return { ...m, ...(snippet ? { plain: (plain || '').slice(0, snippet) } : {}), blockCount: (blocks || []).length, hasImages: (blocks || []).some((b) => b.type === 'image' || b.type === 'gallery') }; };

  function descendants(all, id) { const kids = new Map(); for (const n of all) { const k = n.parentId || ''; (kids.get(k) || kids.set(k, []).get(k)).push(n); } const out = []; const walk = (i) => { for (const c of kids.get(i) || []) { out.push(c); walk(c.id); } }; walk(id); return out; }

  async function create(user, b, { keepId = false } = {}) {
    const kind = v.enum(b.kind || 'page', 'kind', KINDS);
    if ((await nodes.count({ ownerId: user.id })) >= MAX_NODES) throw badRequest('Page limit reached');
    let parentId = b.parentId || null;
    if (parentId) { const p = await own(parentId, user); if (p.trashedAt) throw badRequest('That parent is in the trash'); if (kind === 'entry' && p.kind !== 'database') throw badRequest('Entries must live in a database'); if (p.kind === 'entry') throw badRequest('Entries cannot have sub-pages'); }
    else if (kind === 'entry') throw badRequest('Entries must live in a database');
    const n = derive({ id: keepId && b.id ? v.anyId(b.id, 'id') : newId('pg'), ownerId: user.id, kind, parentId, dbId: kind === 'entry' ? parentId : null, title: str(b.title ?? 'Untitled', 'title', 200), icon: str(b.icon, 'icon', 8), cover: str(b.cover, 'cover', 600),
      tags: v.stringArray(b.tags || [], 'tags', { max: 30, itemMax: 40 }), favorite: bool(b.favorite), journalDate: date(b.journalDate), trashedAt: null, trashRoot: null, order: Number.isFinite(b.order) ? b.order : Date.now(),
      blocks: cleanBlocks(b.blocks || []), props: b.props ? cleanValues(b.props) : {}, schema: kind === 'database' ? cleanSchema(b.schema || {}) : null, rev: 1, schemaVersion: 1 });
    if (b.cover && !srcOk(n.cover) && !/^grad:[a-z0-9-]+$/.test(n.cover)) n.cover = '';
    return nodes.insert(n);
  }

  router.add('GET', `${P}/meta`, async ({ user }) => {
    await can(user, 'page.read');
    const cl = cloud.cloudName && cloud.uploadPreset ? { cloudName: cloud.cloudName, uploadPreset: cloud.uploadPreset, folder: `universe/pulsar/${user.id}`, maxBytes: 10 * 1024 * 1024 } : null;
    let canWrite = true, canDelete = true; try { await can(user, 'page.write'); } catch { canWrite = false; } try { await can(user, 'page.delete'); } catch { canDelete = false; }
    return { canWrite, canDelete, userId: user.id, images: cl ? 'cloudinary' : localOk ? 'local' : 'none', files: localOk ? 'local' : 'none', maxLocalBytes: MAX_LOCAL, cloudinary: cl,
      note: cl || localOk ? '' : 'Image uploads need Cloudinary (set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET) when the database is not SQLite.' };
  });

  router.add('GET', `${P}/nodes`, async ({ user, query }) => {
    await can(user, 'page.read'); const trashed = query.get('trashed') === '1'; const all = await mine(user);
    return { nodes: all.filter((n) => !!n.trashedAt === trashed).map((n) => meta(n)).sort((a, b) => (a.order || 0) - (b.order || 0)) };
  });
  router.add('GET', `${P}/nodes/:id`, async ({ user, params }) => { await can(user, 'page.read'); return { node: await own(params.id, user) }; });
  router.add('POST', `${P}/nodes`, async ({ user, body }) => { await can(user, 'page.write'); allowKeys(v.object(body), ['kind', 'parentId', 'title', 'icon', 'cover', 'tags', 'favorite', 'journalDate', 'blocks', 'props', 'schema', 'order']); return reply(201, { node: await create(user, body) }); }, { bodyLimit: 4 * 1024 * 1024 });

  router.add('PATCH', `${P}/nodes/:id`, async ({ user, params, body }) => {
    await can(user, 'page.write'); const n = await own(params.id, user); if (n.trashedAt) throw conflict('This page is in the trash. Restore it to edit.', 'trashed');
    const b = allowKeys(v.object(body), ['rev', 'title', 'icon', 'cover', 'tags', 'favorite', 'blocks', 'parentId', 'props', 'schema', 'order']);
    if (Number.isInteger(b.rev) && b.rev !== n.rev) return reply(409, { error: { code: 'conflict', message: 'This page was changed somewhere else.' }, node: n });
    const p = {};
    if ('title' in b) p.title = str(b.title, 'title', 200); if ('icon' in b) p.icon = str(b.icon, 'icon', 8);
    if ('cover' in b) { const c = str(b.cover, 'cover', 600); p.cover = srcOk(c) || /^grad:[a-z0-9-]+$/.test(c) ? c : ''; }
    if ('tags' in b) p.tags = v.stringArray(b.tags, 'tags', { max: 30, itemMax: 40 }); if ('favorite' in b) p.favorite = bool(b.favorite); if ('order' in b && Number.isFinite(b.order)) p.order = b.order;
    if ('blocks' in b) { p.blocks = cleanBlocks(b.blocks); p.plain = blocksPlain(p.blocks); p.links = blockLinks(p.blocks); }
    if ('props' in b) p.props = cleanValues(b.props);
    if ('schema' in b) { if (n.kind !== 'database') throw badRequest('Only databases have a schema'); p.schema = cleanSchema(b.schema); }
    if ('parentId' in b) {
      const pid = b.parentId || null;
      if (n.kind === 'entry') throw badRequest('Entries cannot be moved out of their database');
      if (pid) { const par = await own(pid, user); if (par.trashedAt || par.kind === 'entry') throw badRequest('Cannot move there'); if (pid === n.id || descendants(await mine(user), n.id).some((d) => d.id === pid)) throw badRequest('A page cannot be moved inside itself'); }
      p.parentId = pid;
    }
    return { node: await nodes.update(n.id, { ...p, rev: n.rev + 1 }) };
  }, { bodyLimit: 4 * 1024 * 1024 });

  async function setTrash(user, id, on) {
    const n = await own(id, user); const all = await mine(user); const tree = [n, ...descendants(all, id)], now = new Date().toISOString();
    if (on) { for (const t of tree) if (!t.trashedAt) await nodes.update(t.id, { trashedAt: now, trashRoot: id }); return { ok: true, count: tree.length }; }
    if (!n.trashedAt) return { ok: true, count: 0 };
    if (n.kind === 'entry') { const db = await nodes.get(n.dbId); if (!db || db.trashedAt) throw conflict('Restore the database first.'); }
    const par = n.parentId ? all.find((x) => x.id === n.parentId) : null; let moved = false;
    if (n.parentId && (!par || par.trashedAt) && n.kind !== 'entry') { await nodes.update(id, { parentId: null }); moved = true; }
    let c = 0; for (const t of tree) if (t.trashRoot === id) { await nodes.update(t.id, { trashedAt: null, trashRoot: null }); c++; }
    return { ok: true, count: c, movedToTop: moved };
  }
  router.add('POST', `${P}/nodes/:id/trash`, async ({ user, params }) => { await can(user, 'page.delete'); return setTrash(user, params.id, true); });
  router.add('POST', `${P}/nodes/:id/restore`, async ({ user, params }) => { await can(user, 'page.write'); return setTrash(user, params.id, false); });
  router.add('DELETE', `${P}/nodes/:id`, async ({ user, params }) => {
    await can(user, 'page.delete'); const n = await own(params.id, user); if (!n.trashedAt) throw conflict('Move it to the trash first.', 'not_trashed');
    const tree = [n, ...descendants(await mine(user), n.id)]; for (const t of tree) await nodes.delete(t.id); return { ok: true, deleted: tree.length };
  });
  router.add('POST', `${P}/trash/empty`, async ({ user }) => { await can(user, 'page.delete'); const t = (await mine(user)).filter((n) => n.trashedAt); for (const n of t) await nodes.delete(n.id); return { ok: true, deleted: t.length }; });

  router.add('POST', `${P}/nodes/:id/duplicate`, async ({ user, params }) => {
    await can(user, 'page.write'); const root = await own(params.id, user); const all = await mine(user); const tree = [root, ...descendants(all, root.id).filter((d) => !d.trashedAt)];
    if (all.length + tree.length > MAX_NODES) throw badRequest('Page limit reached'); const map = new Map(tree.map((t) => [t.id, newId('pg')])); let copy = null;
    for (const t of tree) {
      const isRoot = t.id === root.id, { id, rev, trashedAt, trashRoot, ...rest } = t;
      const c = await nodes.insert({ ...rest, id: map.get(t.id), ownerId: user.id, parentId: isRoot ? t.parentId : map.get(t.parentId), dbId: t.dbId ? (map.get(t.dbId) || t.dbId) : null, title: isRoot ? `Copy of ${t.title || 'Untitled'}`.slice(0, 200) : t.title, journalDate: null, favorite: false, order: Date.now() + (isRoot ? 1 : 0), rev: 1, trashedAt: null, trashRoot: null });
      if (isRoot) copy = c;
    }
    return reply(201, { node: copy, count: tree.length });
  });

  router.add('POST', `${P}/journal/:date`, async ({ user, params, body }) => { // open the entry for a day, creating it if missing
    await can(user, 'page.write'); const d = date(params.date); if (!d) throw badRequest('Invalid date'); const b = allowKeys(v.object(body || {}), ['title', 'blocks', 'icon']);
    const ex = (await mine(user)).find((n) => n.journalDate === d && !n.trashedAt); if (ex) return { node: ex, created: false };
    return reply(201, { node: await create(user, { kind: 'page', title: b.title || d, icon: b.icon || '📓', blocks: b.blocks || [], journalDate: d }), created: true });
  });
  router.add('GET', `${P}/nodes/:id/backlinks`, async ({ user, params }) => { await can(user, 'page.read'); await own(params.id, user); return { nodes: (await mine(user)).filter((n) => !n.trashedAt && n.id !== params.id && (n.links || []).includes(params.id)).map((n) => meta(n)) }; });

  router.add('GET', `${P}/search`, async ({ user, query }) => {
    await can(user, 'page.read'); const q = (query.get('q') || '').trim().toLowerCase().slice(0, 100), tag = query.get('tag') || '', fav = query.get('favorite') === '1', since = query.get('since') || '', within = query.get('within') || '', kind = query.get('kind') || '';
    const all = (await mine(user)).filter((n) => !n.trashedAt); const scope = within ? new Set([within, ...descendants(all, within).map((d) => d.id)]) : null; const terms = q.split(/\s+/).filter(Boolean);
    const out = [];
    for (const n of all) {
      if (tag && !(n.tags || []).includes(tag)) continue; if (fav && !n.favorite) continue; if (since && (n.updatedAt || '') < since) continue; if (scope && !scope.has(n.id)) continue; if (kind && n.kind !== kind) continue; if (query.get('journal') === '1' && !n.journalDate) continue;
      let score = 0, snip = ''; const title = (n.title || '').toLowerCase(), plain = n.plain || '', pl = plain.toLowerCase(), tags = (n.tags || []).join(' ').toLowerCase();
      if (terms.length) { for (const t of terms) { if (title.includes(t)) score += 10; else if (tags.includes(t)) score += 4; const i = pl.indexOf(t); if (i >= 0) { score += 2; if (!snip) snip = plain.slice(Math.max(0, i - 40), i + 100).replace(/\s+/g, ' '); } else if (!title.includes(t) && !tags.includes(t)) { score = -1; break; } } if (score < 0) continue; } else score = 1;
      out.push({ ...meta(n), snippet: snip, score });
    }
    out.sort((a, b) => b.score - a.score || (b.updatedAt || '').localeCompare(a.updatedAt || '')); return { nodes: out.slice(0, 100), total: out.length };
  });

  // ---- settings ----
  const defaults = { theme: 'dark', fontSize: 16, width: 'normal', defaultTemplate: 'blank', templates: [], spellcheck: true };
  const getSettings = async (user) => ({ ...defaults, ...((await sets.get(`set_${user.id}`)) || {}) });
  router.add('GET', `${P}/settings`, async ({ user }) => { await can(user, 'page.read'); const { id, ownerId, ...r } = await getSettings(user); return { settings: r }; });
  router.add('PUT', `${P}/settings`, async ({ user, body }) => {
    await can(user, 'page.write'); const b = allowKeys(v.object(body), Object.keys(defaults)), cur = await getSettings(user), p = {};
    if ('theme' in b) p.theme = v.enum(b.theme, 'theme', ['dark', 'light', 'system']); if ('fontSize' in b) p.fontSize = int(b.fontSize, 12, 24, 16); if ('width' in b) p.width = v.enum(b.width, 'width', ['narrow', 'normal', 'wide']);
    if ('defaultTemplate' in b) p.defaultTemplate = str(b.defaultTemplate, 'template', 60); if ('spellcheck' in b) p.spellcheck = bool(b.spellcheck);
    if ('templates' in b) { if (!Array.isArray(b.templates) || b.templates.length > 30) throw badRequest('Too many templates'); p.templates = b.templates.map((t) => ({ id: v.anyId(t.id, 'template id'), name: str(t.name, 'template name', 80, 1), icon: str(t.icon, 'icon', 8), blocks: cleanBlocks(t.blocks || []) })); }
    await sets.upsert({ ...cur, ...p, id: `set_${user.id}`, ownerId: user.id }); const { id, ownerId, ...r } = await getSettings(user); return { settings: r };
  }, { bodyLimit: 2 * 1024 * 1024 });

  // ---- assets ----
  async function readRaw(req, limit) { const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, `File is larger than ${Math.round(limit / 1048576)} MB`, 'too_large'); chunks.push(c); } return Buffer.concat(chunks); }
  router.add('POST', `${P}/assets`, async ({ user, req, query }) => {
    await can(user, 'page.write'); if (!localOk) throw badRequest('Local uploads need the SQLite database. Use Cloudinary for images on this deployment.', 'no_local_storage');
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), isImg = !!IMG_MIME[mime]; if (!isImg && !FILE_MIME.includes(mime)) throw new HttpError(415, 'Unsupported file type. Images: JPEG, PNG, GIF, WebP.', 'unsupported_type');
    if (Number(req.headers['content-length']) > MAX_LOCAL + 1024) throw new HttpError(413, `File is larger than ${MAX_LOCAL / 1048576} MB`, 'too_large');
    const buf = await readRaw(req, MAX_LOCAL); if (!buf.length) throw badRequest('Empty file'); if (!magic(buf, mime)) throw badRequest('File content does not match its type');
    const name = (query.get('name') || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120); const id = newId('as');
    await assets.insert({ id, ownerId: user.id, kind: 'local', mime, name, size: buf.length, data: buf.toString('base64'), schemaVersion: 1 });
    return reply(201, { asset: { id, src: `${P}/assets/${id}/file`, mime, name, size: buf.length, isImage: isImg } });
  }, { raw: true });
  router.add('POST', `${P}/assets/register`, async ({ user, body }) => {
    await can(user, 'page.write'); const b = allowKeys(v.object(body), ['publicId', 'secureUrl', 'width', 'height', 'format', 'bytes']); if (!cloud.cloudName) throw badRequest('Cloudinary is not configured');
    const src = v.httpsUrl(b.secureUrl, 'secureUrl'); if (!srcOk(src) || src === '') throw badRequest('secureUrl must be a Cloudinary URL for this account'); const id = newId('as');
    await assets.insert({ id, ownerId: user.id, kind: 'cloudinary', mime: 'image/*', name: str(b.publicId, 'publicId', 200), size: int(b.bytes, 0, 1e9, 0), url: src, width: int(b.width, 0, 100000, 0), height: int(b.height, 0, 100000, 0), schemaVersion: 1 });
    return reply(201, { asset: { id, src, isImage: true } });
  });
  router.add('GET', `${P}/assets/:id/file`, async ({ user, params, res }) => {
    await can(user, 'page.read'); const a = await assets.get(params.id); if (!a || a.ownerId !== user.id) throw notFound('File not found');
    if (a.kind === 'cloudinary') { res.statusCode = 302; res.setHeader('Location', a.url); res.end(); return { __handled: true }; }
    const buf = Buffer.from(a.data, 'base64'), isImg = !!IMG_MIME[a.mime];
    res.statusCode = 200; res.setHeader('Content-Type', a.mime); res.setHeader('Content-Length', buf.length); res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${isImg ? 'inline' : 'attachment'}; filename="${a.name.replace(/"/g, '')}"`); res.end(buf); return { __handled: true };
  });

  // ---- backup import (batches of nodes from a Pulsar JSON backup) ----
  router.add('POST', `${P}/import`, async ({ user, body }) => {
    await can(user, 'page.write'); const b = allowKeys(v.object(body), ['nodes', 'mode']), mode = v.enum(b.mode || 'merge', 'mode', ['merge', 'replace']);
    if (!Array.isArray(b.nodes) || b.nodes.length > 300) throw badRequest('nodes must be an array of at most 300 items'); const res = { imported: 0, skipped: 0, failed: [] };
    for (const x of b.nodes) {
      try {
        const ex = x.id ? await nodes.get(v.anyId(x.id, 'id')) : null;
        if (ex && ex.ownerId !== user.id) { res.failed.push({ id: x.id, error: 'id belongs to another account' }); continue; }
        if (ex && mode === 'merge') { res.skipped++; continue; }
        const kind = v.enum(x.kind || 'page', 'kind', KINDS);
        const n = derive({ id: x.id || newId('pg'), ownerId: user.id, kind, parentId: x.parentId ? v.anyId(x.parentId, 'parentId') : null, dbId: kind === 'entry' ? v.anyId(x.dbId || x.parentId, 'dbId') : null, title: str(x.title ?? 'Untitled', 'title', 200), icon: str(x.icon, 'icon', 8), cover: srcOk(x.cover || '') || /^grad:[a-z0-9-]+$/.test(x.cover || '') ? x.cover || '' : '',
          tags: v.stringArray(x.tags || [], 'tags', { max: 30, itemMax: 40 }), favorite: bool(x.favorite), journalDate: date(x.journalDate), trashedAt: x.trashedAt ? String(x.trashedAt).slice(0, 40) : null, trashRoot: x.trashRoot ? v.anyId(x.trashRoot, 'trashRoot') : null,
          order: Number.isFinite(x.order) ? x.order : Date.now(), blocks: cleanBlocks(x.blocks || []), props: x.props ? cleanValues(x.props) : {}, schema: kind === 'database' ? cleanSchema(x.schema || {}) : null, rev: 1, schemaVersion: 1 });
        await nodes.upsert(n); res.imported++;
      } catch (e) { res.failed.push({ id: x?.id, error: e.message }); }
    }
    return res;
  }, { bodyLimit: 4 * 1024 * 1024 });

  router.add('GET', `${P}/widget/summary`, async ({ user }) => { await can(user, 'stats.read'); const all = (await mine(user)).filter((n) => !n.trashedAt); return { stats: [{ label: 'Pages', value: all.filter((n) => n.kind === 'page' && !n.journalDate).length }, { label: 'Journal entries', value: all.filter((n) => n.journalDate).length }, { label: 'Databases', value: all.filter((n) => n.kind === 'database').length }] }; });
}
