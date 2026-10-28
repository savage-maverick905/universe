// Page / collection views, autosave, uploads.
import { h, toast, S, B, api, byId, kids, pathOf, iconOf, ago, goto, ask, confirmBox, pickNode, menu, dialog, closer, createNode, loadNodes, coverCss, GRADS, EMOJI, allTemplates, uid, fmtDay, stripBlocks, descendantsOf } from '../lib/state.js';
import { createEditor } from '../editor.js';
import { makeExporter, download, safeName } from '../lib/export.js';
import { renderDb } from './db.js';

const OKIMG = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
async function shrink(file, limit) {
  const isImg = /^image\//.test(file.type) || /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(file.name); if (!isImg) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (sc === 1 && OKIMG.includes(file.type) && file.size <= limit * 0.9) { bmp.close?.(); return file; }
    if (file.type === 'image/gif' && file.size <= limit) { bmp.close?.(); return file; }
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    let out = file.type === 'image/png' ? await new Promise((r) => c.toBlob(r, 'image/png')) : null; if (!out || out.size > limit * 0.9) out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (out) return new File([out], file.name.replace(/\.[^.]+$/, '') + (out.type === 'image/png' ? '.png' : '.jpg'), { type: out.type });
  } catch { /* not decodable here */ }
  return file;
}
export async function uploadFile(file) {
  const m = S.meta, isImg = /^image\//.test(file.type) || /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(file.name);
  if (isImg) {
    if (m.images === 'none') throw new Error(m.note || 'Image uploads are not set up on this server.');
    const limit = m.images === 'cloudinary' ? m.cloudinary.maxBytes : m.maxLocalBytes; const f = await shrink(file, limit);
    if (!OKIMG.includes(f.type)) throw new Error(`“${file.name}” is not a supported image (use JPEG, PNG, GIF or WebP).`);
    if (f.size > limit) throw new Error(`“${file.name}” is still over ${Math.round(limit / 1048576)} MB after shrinking.`);
    if (m.images === 'cloudinary') {
      const fd = new FormData(); fd.append('file', f); fd.append('upload_preset', m.cloudinary.uploadPreset); fd.append('folder', m.cloudinary.folder);
      let r; try { r = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(m.cloudinary.cloudName)}/image/upload`, { method: 'POST', body: fd }); } catch { throw new Error('Could not reach Cloudinary. Check your connection.'); }
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || 'Image upload failed');
      const a = (await api('POST', '/assets/register', { publicId: j.public_id, secureUrl: j.secure_url, width: j.width, height: j.height, format: j.format, bytes: j.bytes })).asset; return { src: a.src, assetId: a.id, name: file.name };
    }
    return rawUpload(f);
  }
  if (m.files === 'none') throw new Error('File attachments need the SQLite database (not available on this deployment).');
  if (file.size > m.maxLocalBytes) throw new Error(`“${file.name}” is larger than ${Math.round(m.maxLocalBytes / 1048576)} MB.`);
  return rawUpload(file);
}
export async function rawUpload(f, name = f.name) {
  const r = await fetch(`${B}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Requested-With': 'universe', 'Content-Type': f.type || 'application/octet-stream' }, body: f });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error?.message || `Upload failed (${r.status})`);
  return { src: j.asset.src, assetId: j.asset.id, name: j.asset.name, size: j.asset.size, mime: j.asset.mime };
}

export function makeSaver(node, setStatus, onSaved) {
  let rev = node.rev, pending = {}, timer, inflight = false, dead = false; const key = `pulsar:draft:${node.id}`;
  const persist = () => { try { localStorage.setItem(key, JSON.stringify({ baseRev: rev, ts: Date.now(), patch: pending })); } catch { /* storage full or blocked */ } };
  const has = () => Object.keys(pending).length > 0;
  async function flush() {
    clearTimeout(timer); if (dead || inflight || !has()) return; inflight = true; const sent = pending; pending = {}; setStatus('saving');
    try { const r = await api('PATCH', `/nodes/${node.id}`, { ...sent, rev }); rev = r.node.rev; node.rev = rev; onSaved?.(r.node); if (has()) { persist(); inflight = false; return flush(); } try { localStorage.removeItem(key); } catch { /* ignore */ } setStatus('saved'); }
    catch (e) {
      pending = { ...sent, ...pending }; persist();
      if (e.status === 409 && e.code === 'conflict') { setStatus('error', 'Changed elsewhere'); conflict(); }
      else { setStatus('error', e.message); timer = setTimeout(flush, 5000); }
    }
    inflight = false;
  }
  async function conflict() {
    const latest = (await api('GET', `/nodes/${node.id}`)).node;
    const d = dialog('This page changed somewhere else', h('p', { class: 'sub' }, 'Another tab or device saved this page after you opened it. Your edits are kept safe on this device. Choose which version to keep.'),
      h('div', { class: 'row actions' }, h('button', { class: 'btn ghost', onclick: () => { pending = {}; try { localStorage.removeItem(key); } catch { /* ignore */ } dead = true; d.close(); location.reload(); } }, 'Load the other version'), h('button', { class: 'btn', onclick: () => { rev = latest.rev; d.close(); flush(); } }, 'Keep my version')));
  }
  return { set(p) { if (dead) return; Object.assign(pending, p); persist(); setStatus('unsaved'); clearTimeout(timer); timer = setTimeout(flush, 900); }, flush, dirty: () => has() || inflight, stop() { dead = true; clearTimeout(timer); },
    beacon() { if (!has() || dead) return; const body = JSON.stringify({ ...pending, rev }); if (body.length < 60000) fetch(`${B}/nodes/${node.id}`, { method: 'PATCH', keepalive: true, headers: { 'X-Requested-With': 'universe', 'Content-Type': 'application/json' }, body }).catch(() => {}); },
    recover() { try { const d = JSON.parse(localStorage.getItem(key) || 'null'); if (d && d.baseRev === rev && d.patch && Object.keys(d.patch).length) return d.patch; } catch { /* ignore */ } return null; } };
}

export async function quickExport(kind, id) {
  const meta = byId(id), ex = makeExporter({ api, onProgress: (t) => toast(t) }); toast('Exporting…');
  try {
    let r, name;
    if (kind === 'pdf') { r = await ex.pagePdf(meta, S.nodes); name = `${safeName(meta.title)}.pdf`; download(r.bytes, name, 'application/pdf'); }
    else if (kind === 'collection-pdf') { r = await ex.combinedPdf([id], S.nodes, meta.title || 'Collection'); name = `${safeName(meta.title)} (combined).pdf`; download(r.bytes, name, 'application/pdf'); }
    else if (kind === 'collection-zip') { r = await ex.zipOfPdfs([id], S.nodes); name = `${safeName(meta.title)} (PDFs).zip`; download(r.bytes, name, 'application/zip'); }
    else if (kind === 'md') { r = await ex.markdownZip([id], S.nodes); name = `${safeName(meta.title)} (Markdown).zip`; download(r.bytes, name, 'application/zip'); }
    reportDialog(name, r);
  } catch (e) { toast(`Export failed: ${e.message}`); }
}
export function reportDialog(name, r) {
  const w = [...new Set([...(r.report?.failed || []).map((f) => `Failed: ${f}`), ...(r.report?.warnings || [])])];
  if (!w.length) { toast(`Exported ${name}${r.pages ? ` (${r.pages} PDF pages)` : ''}`); return; }
  dialog('Export finished with notes', h('p', { class: 'sub' }, `${name} was created, but please review:`), h('ul', { class: 'warn' }, w.slice(0, 40).map((x) => h('li', {}, x))), h('div', { class: 'row actions' }, closer('OK')));
}

function header(node, saver, ctx, { cover = true } = {}) {
  const titleEl = h('h1', { class: 'title', contenteditable: 'plaintext-only', 'data-ph': 'Untitled', role: 'textbox', 'aria-label': 'Page title', spellcheck: 'true' }); titleEl.textContent = node.title === 'Untitled' ? '' : node.title;
  titleEl.addEventListener('input', () => { node.title = titleEl.textContent.replace(/\n/g, ' ').slice(0, 200) || ''; saver.set({ title: node.title || 'Untitled' }); const m = byId(node.id); if (m) { m.title = node.title || 'Untitled'; ctx.sidebarSoon(); } });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.focusBody?.(); } });
  const iconBtn = h('button', { class: 'pageicon', type: 'button', 'aria-label': 'Change icon', title: 'Change icon', onclick: (e) => menu([...EMOJI.map((em) => ({ label: em, run: () => setIcon(em) })), { sep: true }, { label: 'Remove icon', run: () => setIcon('') }], e.currentTarget) }, iconOf(node));
  function setIcon(i) { node.icon = i; iconBtn.textContent = iconOf(node); saver.set({ icon: i }); const m = byId(node.id); if (m) m.icon = i; ctx.sidebarSoon(); }
  const coverEl = h('div', { class: 'cover', hidden: node.cover ? null : '' }); const paintCover = () => { coverEl.style.background = coverCss(node.cover); coverEl.hidden = !node.cover; };
  const setCover = (c) => { node.cover = c; saver.set({ cover: c }); paintCover(); };
  const coverMenu = (e) => menu([...Object.keys(GRADS).map((g) => ({ label: `Gradient: ${g}`, run: () => setCover(`grad:${g}`) })), { label: 'Upload image…', run: () => { const i = h('input', { type: 'file', accept: 'image/*', style: 'position:fixed;left:-999px', onchange: async () => { try { const a = await uploadFile(i.files[0]); setCover(a.src); } catch (x) { toast(x.message); } i.remove(); } }); document.body.append(i); i.click(); } }, { sep: true }, { label: 'Remove cover', run: () => setCover('') }], e.currentTarget);
  coverEl.append(h('div', { class: 'cb' }, h('button', { class: 'btn ghost small', type: 'button', onclick: coverMenu }, 'Change cover'))); paintCover();
  const tags = h('div', { class: 'meta' }); const drawTags = () => { const inp = h('input', { class: 'tagadd', placeholder: '+ tag', maxlength: 40, 'aria-label': 'Add tag', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const t = inp.value.trim().replace(/,/g, ''); if (t && !node.tags.includes(t)) { node.tags = [...node.tags, t]; saver.set({ tags: node.tags }); const m = byId(node.id); if (m) m.tags = node.tags; drawTags(); tags.querySelector('input').focus(); } } } });
    tags.replaceChildren(...node.tags.map((t) => h('span', { class: 'chip' }, t, h('button', { type: 'button', 'aria-label': `Remove tag ${t}`, onclick: () => { node.tags = node.tags.filter((x) => x !== t); saver.set({ tags: node.tags }); const m = byId(node.id); if (m) m.tags = node.tags; drawTags(); } }, '×'))), inp, h('span', {}, node.journalDate ? '🔒 Private journal entry' : `Edited ${ago(node.updatedAt)}`)); };
  drawTags();
  return { coverEl, iconBtn, titleEl, tags, setCover, coverMenu };
}

export async function pageView(id, ctx) {
  const node = (await api('GET', `/nodes/${id}`)).node; node.tags ||= []; node.rendered = true;
  const saver = makeSaver(node, (s, msg) => ctx.setStatus(s, msg), (n) => { const m = byId(node.id); if (m) Object.assign(m, stripBlocks(n)); node.updatedAt = n.updatedAt; });
  const recov = saver.recover(); if (recov) { Object.assign(node, recov); saver.set(recov); toast('Recovered unsaved changes from this device'); }
  const hd = header(node, saver, ctx); let ed = null; const dispose = [];
  const crumbs = pathOf(node).map((p) => ({ label: `${iconOf(p)} ${p.title || 'Untitled'}`, href: `#/p/${p.id}` }));
  ctx.setCrumbs(node.journalDate ? [{ label: '📓 Journal', href: '#/journal' }, { label: node.title || node.journalDate }] : node.kind === 'entry' ? [...crumbs, { label: iconOf(node) + ' ' + (node.title || 'Untitled') }] : [...crumbs, { label: `${iconOf(node)} ${node.title || 'Untitled'}` }]);
  const body = h('div');
  const actions = (e) => {
    const m = byId(node.id) || node, items = [{ label: node.favorite ? 'Remove from favorites' : 'Add to favorites', run: async () => { node.favorite = !node.favorite; saver.set({ favorite: node.favorite }); m.favorite = node.favorite; ctx.sidebarSoon(); toast(node.favorite ? 'Added to favorites' : 'Removed from favorites'); } },
      { label: 'Add or change cover', run: () => hd.coverMenu({ currentTarget: e.currentTarget }) }, { sep: true }];
    if (!node.journalDate && node.kind !== 'entry') items.push({ label: 'Duplicate', run: async () => { await saver.flush(); try { const r = await api('POST', `/nodes/${node.id}/duplicate`); await loadNodes(); toast(`Duplicated (${r.count})`); goto(`#/p/${r.node.id}`); } catch (x) { toast(x.message); } } }, { label: 'Move to…', run: async () => { const ex = new Set([node.id, ...descendantsOf(node.id).map((d) => d.id)]); const t = await pickNode({ title: 'Move to', exclude: ex, kinds: ['collection', 'page'], allowTop: true }); if (!t) return; try { await api('PATCH', `/nodes/${node.id}`, { parentId: t.id }); await loadNodes(); toast('Moved'); goto(`#/p/${node.id}`); ctx.route(); } catch (x) { toast(x.message); } } });
    if (node.kind === 'page') items.push({ label: 'Save as template', run: async () => { const nm = await ask('Save as template', 'Template name', node.title || 'Untitled'); if (!nm) return; await saver.flush(); const cur = (await api('GET', `/nodes/${node.id}`)).node; const list = [...(S.settings.templates || []), { id: uid('tpl'), name: nm.slice(0, 80), icon: node.icon || '', blocks: cur.blocks }]; try { S.settings = (await api('PUT', '/settings', { templates: list })).settings; toast('Template saved'); } catch (x) { toast(x.message); } } });
    items.push({ sep: true }, { label: 'Export as PDF', run: async () => { await saver.flush(); quickExport('pdf', node.id); } }, { label: 'Export as Markdown (ZIP)', run: async () => { await saver.flush(); quickExport('md', node.id); } }, { label: 'More export options…', run: () => goto(`#/export?sel=${node.id}`) }, { label: 'Print…', run: () => print() });
    items.push({ sep: true }, { label: 'Move to trash', danger: true, run: async () => { if (!(await confirmBox('Move to trash?', `“${node.title || 'Untitled'}”${kids(node.id).length ? ' and its sub-pages' : ''} will go to the trash. You can restore it later.`, 'Move to trash', true))) return; await saver.flush(); try { await api('POST', `/nodes/${node.id}/trash`); await loadNodes(); toast('Moved to trash'); goto(node.parentId && byId(node.parentId) ? `#/p/${node.parentId}` : '#/'); ctx.sidebarSoon(); } catch (x) { toast(x.message); } } });
    menu(items, e.currentTarget);
  };
  ctx.setActions([h('button', { class: 'ib2', type: 'button', title: node.favorite ? 'Unfavorite' : 'Favorite', 'aria-label': 'Toggle favorite', onclick: (e) => { node.favorite = !node.favorite; saver.set({ favorite: node.favorite }); const m = byId(node.id); if (m) m.favorite = node.favorite; e.currentTarget.textContent = node.favorite ? '★' : '☆'; ctx.sidebarSoon(); } }, node.favorite ? '★' : '☆'), h('button', { class: 'ib2', type: 'button', 'aria-label': 'Page options', title: 'Page options', onclick: actions }, '⋯')]);
  const wrap = h('div', { class: 'pagewrap' }, hd.coverEl, h('div', { class: 'content', style: hd.coverEl.hidden ? '' : 'padding-top:0' }, hd.iconBtn, hd.titleEl, hd.tags, body));
  ctx.main(wrap);
  if (node.kind === 'collection') {
    const draw = () => { const ch = kids(node.id); body.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => { const n = await createNode({ parentId: node.id }); goto(`#/p/${n.id}`); ctx.sidebarSoon(); } }, '+ New page'), h('button', { class: 'btn ghost small', onclick: async () => { const n = await createNode({ kind: 'collection', parentId: node.id, title: 'Untitled' }); goto(`#/p/${n.id}`); ctx.sidebarSoon(); } }, '+ Sub-collection'), h('button', { class: 'btn ghost small', onclick: async () => { const n = await createNode({ kind: 'database', parentId: node.id, title: 'Untitled' }); goto(`#/p/${n.id}`); ctx.sidebarSoon(); } }, '+ Database'),
      h('button', { class: 'btn ghost small', onclick: () => quickExport('collection-pdf', node.id) }, 'Export combined PDF'), h('button', { class: 'btn ghost small', onclick: () => quickExport('collection-zip', node.id) }, 'Export PDFs (ZIP)')),
      h('div', { class: 'h2s' }, `${ch.length} item${ch.length === 1 ? '' : 's'}`), ch.length ? h('div', { class: 'grid' }, ch.map((c) => h('a', { class: 'card2', href: `#/p/${c.id}` }, h('span', { class: 'ic' }, iconOf(c)), h('b', {}, c.title || 'Untitled'), h('small', {}, `${c.kind} · ${ago(c.updatedAt)}`)))) : h('div', { class: 'empty' }, 'This collection is empty. Add a page to get started.')); }; draw();
  } else if (node.kind === 'database') {
    renderDb(node, saver, body, ctx);
  } else {
    if (node.kind === 'entry') body.append(entryProps(node, saver));
    ed = createEditor({ blocks: node.blocks, onChange: (bl) => { saver.set({ blocks: bl }); }, uploadFile, pickPage: () => pickNode({ title: 'Link to a page' }), openPage: (i) => goto(`#/p/${i}`), notify: (m, err) => toast(m), ask: (t, l, v) => ask(t, l, v) });
    body.append(ed.toolbar, ed.el); ctx.focusBody = () => ed.focusStart();
    if (!node.blocks.length || (node.blocks.length === 1 && !node.blocks[0].html && !node.title)) setTimeout(() => hd.titleEl.focus(), 50); else if (node.title === 'Untitled' && !node.journalDate) setTimeout(() => hd.titleEl.focus(), 50);
    if (node.journalDate) { const d = new Date(`${node.journalDate}T12:00:00`), add = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }; body.prepend(h('div', { class: 'row', style: 'margin-bottom:.6rem' }, h('a', { class: 'btn ghost small', href: `#/journal/${add(-1)}` }, '← Previous day'), h('span', { class: 'sub', style: 'margin:0' }, fmtDay(node.journalDate)), h('a', { class: 'btn ghost small', href: `#/journal/${add(1)}` }, 'Next day →'))); }
    const ch = kids(node.id); if (ch.length) body.append(h('div', { class: 'h2s' }, 'Sub-pages'), h('div', { class: 'grid' }, ch.map((c) => h('a', { class: 'card2', href: `#/p/${c.id}` }, h('span', { class: 'ic' }, iconOf(c)), h('b', {}, c.title || 'Untitled')))));
    if (node.kind === 'page' && !node.journalDate) body.append(h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn ghost small', onclick: async () => { await saver.flush(); const n = await createNode({ parentId: node.id }); ctx.sidebarSoon(); goto(`#/p/${n.id}`); } }, '+ Add sub-page')));
    api('GET', `/nodes/${node.id}/backlinks`).then((r) => { if (r.nodes.length) body.append(h('div', { class: 'h2s' }, `Linked from (${r.nodes.length})`), h('div', { class: 'grid' }, r.nodes.map((c) => h('a', { class: 'card2', href: `#/p/${c.id}` }, h('span', { class: 'ic' }, iconOf(c)), h('b', {}, c.title || 'Untitled'))))); }).catch(() => {});
  }
  const onHide = () => { if (document.visibilityState === 'hidden') { saver.flush(); saver.beacon(); } }, onUnload = (e) => { if (saver.dirty()) { saver.beacon(); e.preventDefault(); e.returnValue = ''; } }, onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saver.flush(); } };
  document.addEventListener('visibilitychange', onHide); addEventListener('beforeunload', onUnload); document.addEventListener('keydown', onKey); ctx.setStatus(recov ? 'unsaved' : 'saved');
  return async () => { document.removeEventListener('visibilitychange', onHide); removeEventListener('beforeunload', onUnload); document.removeEventListener('keydown', onKey); ed?.snapshot(); await saver.flush(); saver.stop(); ed?.destroy(); ctx.setActions([]); };
}

function entryProps(node, saver) {
  const db = byId(node.dbId); if (!db?.schema?.props?.length) return h('div');
  const box = h('div', { class: 'props' });
  for (const p of db.schema.props) {
    const val = node.props?.[p.id]; const set = (v) => { node.props = { ...(node.props || {}), [p.id]: v }; saver.set({ props: node.props }); const m = byId(node.id); if (m) m.props = node.props; };
    let inp;
    if (p.type === 'checkbox') inp = h('input', { type: 'checkbox', checked: val ? '' : null, onchange: (e) => set(e.target.checked) });
    else if (['select', 'status'].includes(p.type)) inp = h('select', { onchange: (e) => set(e.target.value || null) }, h('option', { value: '' }, '—'), p.options.map((o) => h('option', { value: o.id, selected: val === o.id ? '' : null }, o.name)));
    else if (p.type === 'multi_select') { inp = h('div', { class: 'row' }); const draw = () => { const cur = node.props?.[p.id] || []; inp.replaceChildren(...cur.map((i) => h('span', { class: 'opt', style: `background:${p.options.find((o) => o.id === i)?.color || '#707070'}` }, p.options.find((o) => o.id === i)?.name || i)), h('select', { onchange: (e) => { if (e.target.value) { set([...new Set([...cur, e.target.value])]); draw(); } } }, h('option', { value: '' }, '+ add'), p.options.filter((o) => !cur.includes(o.id)).map((o) => h('option', { value: o.id }, o.name))), cur.length ? h('button', { class: 'tb', type: 'button', onclick: () => { set([]); draw(); } }, 'Clear') : null); }; draw(); }
    else if (p.type === 'relation') { inp = h('div', { class: 'row' }); const draw = () => { const cur = node.props?.[p.id] || []; inp.replaceChildren(...cur.map((i) => h('a', { class: 'chip', href: `#/p/${i}` }, byId(i)?.title || '(missing)')), h('button', { class: 'tb', type: 'button', onclick: async () => { const t = await pickNode({ title: `Relate “${p.name}”` }); if (t) { set([...new Set([...cur, t.id])]); draw(); } } }, '+ link'), cur.length ? h('button', { class: 'tb', type: 'button', onclick: () => { set([]); draw(); } }, 'Clear') : null); }; draw(); }
    else inp = h('input', { type: p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : p.type === 'url' ? 'url' : 'text', value: val ?? '', onchange: (e) => set(p.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value) });
    box.append(h('label', {}, p.name), inp);
  }
  return box;
}
