// Pulsar block editor: every block is its own contenteditable (or a media/table block), so images and tables can sit between
// any two paragraphs. Blocks are plain JSON; inline formatting is a sanitised HTML subset (see lib/inline.js).
import { h } from '/shared/ui.js';
import { sanitizeHtml, htmlToText, listNumbers } from './lib/inline.js';

const TEXT = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'callout', 'code'];
const PH = { p: "Type '/' for commands", h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', ul: 'List', ol: 'List', todo: 'To-do', quote: 'Quote', callout: 'Callout', code: 'Code' };
export const SLASH = [['Text', 'p', 'plain paragraph'], ['Heading 1', 'h1', 'big heading'], ['Heading 2', 'h2', 'medium heading'], ['Heading 3', 'h3', 'small heading'], ['Bulleted list', 'ul', 'bullets'], ['Numbered list', 'ol', 'numbers'], ['Checklist', 'todo', 'to-do items'], ['Quote', 'quote', 'blockquote'], ['Callout', 'callout', 'highlighted note'],
  ['Code', 'code', 'code block'], ['Divider', 'hr', 'horizontal line'], ['Table', 'table', 'rows and columns'], ['Image', 'image', 'upload a picture'], ['Image row', 'gallery', 'pictures side by side'], ['File', 'file', 'attach a file'], ['Link to page', 'pagelink', 'link another page'], ['Table of contents', 'toc', 'from headings']];
const COLORS = [['Default', ''], ['Gray', '#8a8a8a'], ['Red', '#e5484d'], ['Orange', '#ed6627'], ['Yellow', '#c99a00'], ['Green', '#2f9e60'], ['Blue', '#2f7de1'], ['Purple', '#8e4ec6']];
export const bid = () => `b_${Math.random().toString(36).slice(2, 11)}${Date.now().toString(36).slice(-3)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

export function createEditor({ blocks = [], readOnly = false, onChange = () => {}, uploadFile, pickPage, openPage, notify = () => {}, ask }) {
  let B = clone(blocks); if (!B.length) B = [{ id: bid(), type: 'p', html: '' }];
  const el = h('div', { class: 'ed', spellcheck: 'true' }), toolbar = h('div', { class: 'edbar', role: 'toolbar', 'aria-label': 'Formatting' });
  let hist = [JSON.stringify(B)], hi = 0, histTimer = null, tocTimer = null, selected = new Set(), lastCell = null, menuEl = null, slash = null, savedRange = null;
  const idx = (id) => B.findIndex((b) => b.id === id), get = (id) => B[idx(id)], wrap = (id) => el.querySelector(`.blk[data-id="${id}"]`);
  const clean = () => B.filter((b) => !b._pending).map(({ _pending, ...r }) => r);
  const changed = (now = false) => { onChange(clean()); clearTimeout(tocTimer); tocTimer = setTimeout(refreshToc, 500); clearTimeout(histTimer); if (now) snap(); else histTimer = setTimeout(snap, 450); };
  const snap = () => { clearTimeout(histTimer); const s = JSON.stringify(clean()); if (s === hist[hi]) return; hist = hist.slice(0, hi + 1); hist.push(s); if (hist.length > 150) hist.shift(); hi = hist.length - 1; syncBar(); };
  function restore(n) { if (n < 0 || n >= hist.length) return; snap(); hi = n; B = JSON.parse(hist[hi]); if (!B.length) B = [{ id: bid(), type: 'p', html: '' }]; renderAll(); onChange(clean()); syncBar(); }
  const undo = () => { snap(); restore(hi - 1); }, redo = () => restore(hi + 1);

  // ---------- caret helpers ----------
  const sel = () => getSelection();
  const inEl = (n) => !!n && el.contains(n.nodeType === 3 ? n.parentNode : n);
  function setCaret(node, end = false) { const r = document.createRange(); r.selectNodeContents(node); r.collapse(!end); const s = sel(); s.removeAllRanges(); s.addRange(r); }
  function setCaretAt(node, n) { const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let c = 0, t; while ((t = w.nextNode())) { if (c + t.length >= n) { const r = document.createRange(); r.setStart(t, n - c); r.collapse(true); sel().removeAllRanges(); sel().addRange(r); return; } c += t.length; } setCaret(node, true); }
  const atStart = (node) => { const s = sel(); if (!s.rangeCount || !s.isCollapsed || !node.contains(s.anchorNode)) return false; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(node); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString() === '' && !r.cloneContents().querySelector('img,br+*'); };
  const atEnd = (node) => { const s = sel(); if (!s.rangeCount || !s.isCollapsed || !node.contains(s.anchorNode)) return false; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(node); r.setStart(s.anchorNode, s.anchorOffset); return r.toString() === ''; };
  const curBlockId = () => { const n = sel().anchorNode; const w = n && (n.nodeType === 3 ? n.parentNode : n).closest?.('.blk'); return w && el.contains(w) ? w.dataset.id : null; };
  function focusBlock(id, where = 'start') { const w = wrap(id); if (!w) return; const t = w.querySelector('.txt, td[contenteditable], figcaption'); if (!t) { selectBlocks([id]); return; } t.focus(); if (typeof where === 'number') setCaretAt(t, where); else setCaret(t, where === 'end'); }

  // ---------- rendering ----------
  const numbers = () => listNumbers(B);
  function renumber() { const n = numbers(); el.querySelectorAll('.blk[data-type=ol] .mk').forEach((m) => { m.textContent = `${n[m.closest('.blk').dataset.id] || 1}.`; }); }
  function mk(b) {
    const w = h('div', { class: `blk b-${b.type}`, 'data-id': b.id, 'data-type': b.type, style: b.indent ? `--ind:${b.indent}` : null });
    const gut = readOnly ? null : h('div', { class: 'gut', contenteditable: 'false' },
      h('button', { class: 'gb', type: 'button', 'aria-label': 'Add block below', title: 'Add block below', tabindex: '-1', onclick: () => { const nb = addAfter(b.id, { type: 'p', html: '' }); focusBlock(nb.id); setTimeout(() => openSlash(nb.id, ''), 0); } }, '+'),
      h('button', { class: 'gb grip', type: 'button', draggable: 'true', 'aria-label': 'Block options', title: 'Drag to move, click for options', tabindex: '-1', onclick: (e) => blockMenu(b.id, e.currentTarget), ondragstart: (e) => { e.dataTransfer.setData('application/x-pulsar-block', b.id); e.dataTransfer.effectAllowed = 'move'; w.classList.add('dragging'); }, ondragend: () => { w.classList.remove('dragging'); clearDrop(); } }, '⋮⋮'));
    const body = h('div', { class: 'body' });
    if (TEXT.includes(b.type)) {
      const t = h('div', { class: `txt t-${b.type}`, contenteditable: readOnly ? 'false' : (b.type === 'code' ? 'plaintext-only' : 'true'), 'data-ph': PH[b.type], role: 'textbox', 'aria-label': PH[b.type] });
      if (b.type === 'code') t.textContent = htmlToText(b.html || ''); else t.innerHTML = b.html || '';
      if (b.type === 'todo') body.append(h('input', { type: 'checkbox', class: 'mk chk', checked: b.checked ? '' : null, disabled: readOnly ? '' : null, 'aria-label': 'Done', onchange: (e) => { b.checked = e.target.checked; w.classList.toggle('done', b.checked); changed(true); } }));
      if (b.type === 'ul') body.append(h('span', { class: 'mk', 'aria-hidden': 'true' }, ['•', '◦', '▪'][(b.indent || 0) % 3]));
      if (b.type === 'ol') body.append(h('span', { class: 'mk', 'aria-hidden': 'true' }, '1.'));
      if (b.type === 'callout') body.append(h('button', { class: 'mk cicon', type: 'button', 'aria-label': 'Change icon', onclick: () => { const ic = prompt('Callout icon (an emoji or a few characters)', b.icon || '💡'); if (ic !== null) { b.icon = ic.slice(0, 8); e2(b); } } }, b.icon || '💡'));
      if (b.type === 'code') body.append(h('input', { class: 'lang', value: b.lang || '', placeholder: 'language', 'aria-label': 'Code language', maxlength: 30, oninput: (e) => { b.lang = e.target.value; changed(); } }));
      if (b.type === 'todo' && b.checked) w.classList.add('done');
      body.append(t);
    } else if (b.type === 'hr') body.append(h('hr'));
    else if (b.type === 'toc') body.append(h('nav', { class: 'toc', 'aria-label': 'Table of contents' }));
    else if (b.type === 'table') body.append(mkTable(b));
    else if (b.type === 'image') body.append(mkImage(b, w));
    else if (b.type === 'gallery') body.append(mkGallery(b));
    else if (b.type === 'pagelink') body.append(h('a', { class: 'plink', href: `#/p/${b.pageId}` }, h('span', {}, '📄'), h('b', {}, b.title || 'Linked page')));
    else if (b.type === 'file') body.append(h('a', { class: 'filecard', href: b.src, target: '_blank', rel: 'noopener', download: b.name || '' }, h('span', {}, '📎'), h('b', {}, b.name || 'Attachment'), h('small', {}, b.size ? `${Math.max(1, Math.round(b.size / 1024))} KB` : '')));
    w.append(...(gut ? [gut] : []), body);
    return w;
  }
  const e2 = (b) => { replace(b.id); changed(true); };
  function replace(id) { const old = wrap(id), nw = mk(get(id)); old.replaceWith(nw); renumber(); refreshToc(); return nw; }
  function renderAll() { el.replaceChildren(...B.map(mk)); renumber(); refreshToc(); selected.clear(); }
  function refreshToc() { el.querySelectorAll('.toc').forEach((n) => { const hs = B.filter((b) => /^h[123]$/.test(b.type) && htmlToText(b.html).trim()); n.replaceChildren(...(hs.length ? hs.map((b) => h('a', { class: `tl-${b.type}`, href: 'javascript:void 0', onclick: () => wrap(b.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, htmlToText(b.html))) : [h('i', {}, 'Add headings to build a table of contents.')])); }); }
  function addAfter(id, partial, { render = true } = {}) { const nb = { id: bid(), ...partial }, i = id ? idx(id) : B.length - 1; B.splice(i + 1, 0, nb); if (render) { const nw = mk(nb); (id ? wrap(id) : el.lastElementChild)?.after(nw); if (!id && !el.lastElementChild) el.append(nw); renumber(); } changed(true); return nb; }
  function removeBlock(id) { const i = idx(id); if (i < 0) return; B.splice(i, 1); wrap(id)?.remove(); if (!B.length) { B.push({ id: bid(), type: 'p', html: '' }); el.append(mk(B[0])); } renumber(); changed(true); }

  // ---------- tables ----------
  function mkTable(b) {
    const tbl = h('table'), cellsOf = () => b.rows;
    b.rows.forEach((r, ri) => { const tr = h('tr'); r.forEach((c, ci) => { const td = h(ri === 0 && b.header !== false ? 'th' : 'td', { contenteditable: readOnly ? 'false' : 'true', 'data-r': ri, 'data-c': ci, 'aria-label': `Row ${ri + 1}, column ${ci + 1}` }); td.innerHTML = c; tr.append(td); }); tbl.append(tr); });
    const upd = (td) => { b.rows[+td.dataset.r][+td.dataset.c] = sanitizeHtml(td.innerHTML); changed(); };
    tbl.addEventListener('input', (e) => { if (e.target.matches('th,td')) upd(e.target); });
    tbl.addEventListener('focusin', (e) => { if (e.target.matches('th,td')) lastCell = { id: b.id, r: +e.target.dataset.r, c: +e.target.dataset.c }; });
    tbl.addEventListener('keydown', (e) => { if (e.key !== 'Tab' || !e.target.matches('th,td')) return; e.preventDefault(); const r = +e.target.dataset.r, c = +e.target.dataset.c, cols = b.rows[0].length; let nr = r, nc = c + (e.shiftKey ? -1 : 1); if (nc >= cols) { nc = 0; nr++; } if (nc < 0) { nc = cols - 1; nr--; } if (nr < 0) return; if (nr >= b.rows.length) { b.rows.push(Array(cols).fill('')); e2(b); } const t = wrap(b.id).querySelector(`[data-r="${nr}"][data-c="${nc}"]`); t?.focus(); setCaret(t, true); });
    const bar = readOnly ? null : h('div', { class: 'tbar', contenteditable: 'false' },
      ...[['+ Row', () => { const i = lastCell?.id === b.id ? lastCell.r + 1 : b.rows.length; b.rows.splice(i, 0, Array(b.rows[0].length).fill('')); e2(b); }], ['+ Column', () => { const i = lastCell?.id === b.id ? lastCell.c + 1 : b.rows[0].length; b.rows.forEach((r) => r.splice(i, 0, '')); e2(b); }],
        ['− Row', () => { if (b.rows.length > 1) { b.rows.splice(lastCell?.id === b.id ? lastCell.r : b.rows.length - 1, 1); e2(b); } }], ['− Column', () => { if (b.rows[0].length > 1) { const i = lastCell?.id === b.id ? lastCell.c : b.rows[0].length - 1; b.rows.forEach((r) => r.splice(i, 1)); e2(b); } }], ['Header row', () => { b.header = b.header === false; e2(b); }]]
        .map(([t, fn]) => h('button', { type: 'button', class: 'tb', onmousedown: (e) => e.preventDefault(), onclick: fn }, t)));
    return h('div', { class: 'tablewrap' }, h('div', { class: 'tscroll' }, tbl), bar);
  }

  // ---------- images ----------
  const imgEl = (src, alt) => h('img', { src, alt: alt || '', loading: 'lazy', draggable: 'false', onerror: (e) => { e.target.replaceWith(h('div', { class: 'imgfail' }, 'Image could not be loaded')); } });
  const cap = (b) => { const c = h('figcaption', { contenteditable: readOnly ? 'false' : 'true', 'data-ph': 'Add a caption', role: 'textbox', 'aria-label': 'Image caption' }); c.innerHTML = b.caption || ''; c.addEventListener('input', () => { b.caption = sanitizeHtml(c.innerHTML); changed(); }); c.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const nb = nextTextAfter(b.id); focusBlock(nb, 'start'); } }); return c; };
  function nextTextAfter(id) { const i = idx(id); let n = B[i + 1]; if (!n || !TEXT.includes(n.type)) n = addAfter(id, { type: 'p', html: '' }); return n.id; }
  function mkImage(b, w) {
    const fig = h('figure', { class: `imgfig al-${b.align || 'center'}`, style: `--w:${b.w || 100}%`, tabindex: '0', 'aria-label': `Image${b.alt ? `: ${b.alt}` : ''}` });
    if (b._pending) { fig.append(h('div', { class: 'uploading' }, b._pending === 'error' ? 'Upload failed' : 'Uploading…')); return fig; }
    const frame = h('div', { class: 'imgframe' }, imgEl(b.src, b.alt));
    if (!readOnly) {
      const rs = h('span', { class: 'rs', title: 'Drag to resize', role: 'slider', 'aria-label': 'Resize image' });
      rs.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); rs.setPointerCapture(e.pointerId); const host = fig.parentElement.getBoundingClientRect(), al = b.align || 'center';
        const mv = (ev) => { const x = ev.clientX; const pct = al === 'left' ? (x - host.left) / host.width : al === 'right' ? (host.right - x) / host.width : 2 * Math.abs(x - (host.left + host.width / 2)) / host.width; b.w = Math.max(10, Math.min(100, Math.round(pct * 100))); fig.style.setProperty('--w', `${b.w}%`); };
        const up = () => { rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); changed(true); }; rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); });
      frame.append(rs);
      const mkb = (t, fn, label, on) => h('button', { type: 'button', class: `ib${on ? ' on' : ''}`, 'aria-label': label, title: label, onmousedown: (e) => e.preventDefault(), onclick: fn }, t);
      fig.append(frame, h('div', { class: 'imgbar', contenteditable: 'false' }, ...[25, 50, 75, 100].map((p) => mkb(`${p}%`, () => { b.w = p; e2(b); selectBlocks([b.id]); }, `Width ${p}%`, (b.w || 100) === p)),
        ...[['⇤', 'left'], ['↔', 'center'], ['⇥', 'right']].map(([t, a]) => mkb(t, () => { b.align = a; e2(b); selectBlocks([b.id]); }, `Align ${a}`, (b.align || 'center') === a)),
        mkb('Alt', async () => { const v = await ask?.('Alt text', 'Describe this image for screen readers and exports.', b.alt || ''); if (v !== null && v !== undefined) { b.alt = v.slice(0, 500); e2(b); } }, 'Edit alt text'), mkb('Replace', () => pickFiles('image/*', false, async ([f]) => { const a = await safeUpload(f); if (a) { b.src = a.src; b.assetId = a.assetId; e2(b); } }), 'Replace image'),
        mkb('🗑', () => removeBlock(b.id), 'Delete image')), cap(b));
    } else fig.append(frame, b.caption ? h('figcaption', { innerHTML: '' }, htmlToText(b.caption)) : null);
    frame.addEventListener('click', () => selectBlocks([b.id]));
    return fig;
  }
  function mkGallery(b) {
    const row = h('div', { class: 'grow' }, b.imgs.map((im, i) => h('div', { class: 'gcell' }, imgEl(im.src, im.alt), readOnly ? null : h('button', { class: 'gx', type: 'button', 'aria-label': 'Remove image', onclick: () => { b.imgs.splice(i, 1); if (!b.imgs.length) removeBlock(b.id); else e2(b); } }, '×'))));
    return h('figure', { class: 'gallery' }, row, readOnly ? null : h('button', { class: 'tb', type: 'button', onclick: () => pickFiles('image/*', true, async (fs) => { for (const f of fs) { const a = await safeUpload(f); if (a) b.imgs.push({ src: a.src, assetId: a.assetId, alt: '' }); } e2(b); }) }, '+ Add images'), cap(b));
  }
  async function safeUpload(file) { try { return await uploadFile(file); } catch (e) { notify(e.message || 'Upload failed', true); return null; } }
  function pickFiles(accept, multiple, cb) { const i = h('input', { type: 'file', accept, multiple: multiple ? '' : null, style: 'position:fixed;left:-999px', onchange: () => { const fs = [...i.files]; i.remove(); if (fs.length) cb(fs); } }); document.body.append(i); i.click(); }
  // Insert uploaded images AFTER the block that has the caret (never replacing text), or at the given block.
  async function insertFiles(files, afterId = null) {
    const imgs = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name)), others = files.filter((f) => !imgs.includes(f));
    let at = afterId || curBlockId() || B[B.length - 1]?.id;
    const here = get(at); if (here && here.type === 'p' && !htmlToText(here.html).trim() && !afterId) { /* empty line: image goes after it, line stays for typing */ }
    for (const f of imgs) {
      const nb = addAfter(at, { type: 'image', src: '', alt: '', w: 100, align: 'center', caption: '', _pending: true }); at = nb.id;
      const a = await safeUpload(f); const cur = get(nb.id); if (!cur) continue;
      if (!a) { removeBlock(nb.id); continue; }
      Object.assign(cur, { src: a.src, assetId: a.assetId, alt: f.name.replace(/\.[^.]+$/, '').slice(0, 100) }); delete cur._pending; replace(cur.id); changed(true);
    }
    for (const f of others) { const a = await safeUpload(f); if (a) { const nb = addAfter(at, { type: 'file', src: a.src, assetId: a.assetId, name: a.name || f.name, size: a.size || f.size, mime: a.mime || f.type }); at = nb.id; } }
    const last = B[B.length - 1]; if (last && !TEXT.includes(last.type)) addAfter(last.id, { type: 'p', html: '' });
  }

  // ---------- block operations ----------
  function turnInto(id, type) {
    const b = get(id); if (!b || !TEXT.includes(b.type) || !TEXT.includes(type)) return; const html = b.type === 'code' ? htmlToText(b.html).replace(/\n/g, '<br>') : b.html;
    b.type = type; b.html = type === 'code' ? htmlToText(html.replace(/<br>/g, '\n')).replace(/</g, '&lt;') : html; if (type === 'todo') b.checked = false; if (type !== 'ul' && type !== 'ol' && type !== 'todo') delete b.indent;
    const n = replace(id); changed(true); const t = n.querySelector('.txt'); t?.focus(); t && setCaret(t, true);
  }
  function insertType(afterId, type) {
    const cur = get(afterId), empty = cur && TEXT.includes(cur.type) && !htmlToText(cur.html).trim();
    if (TEXT.includes(type)) { if (empty) { turnInto(afterId, type); return; } const nb = addAfter(afterId, { type, html: '' }); focusBlock(nb.id); return; }
    const place = (partial) => { let nb; if (empty && cur.type === 'p') { Object.keys(cur).forEach((k) => delete cur[k]); Object.assign(cur, { id: afterId, ...partial }); replace(afterId); nb = cur; changed(true); } else nb = addAfter(afterId, partial); const last = B[B.length - 1]; if (!TEXT.includes(last.type)) addAfter(last.id, { type: 'p', html: '' }); return nb; };
    if (type === 'hr') place({ type: 'hr' }); else if (type === 'toc') place({ type: 'toc' });
    else if (type === 'table') { const nb = place({ type: 'table', header: true, rows: [['', '', ''], ['', '', ''], ['', '', '']] }); setTimeout(() => wrap(nb.id)?.querySelector('th')?.focus(), 0); }
    else if (type === 'image') pickFiles('image/*', true, (fs) => insertFiles(fs, afterId));
    else if (type === 'gallery') pickFiles('image/*', true, async (fs) => { const imgs = []; for (const f of fs) { const a = await safeUpload(f); if (a) imgs.push({ src: a.src, assetId: a.assetId, alt: '' }); } if (imgs.length) place({ type: 'gallery', imgs, caption: '' }); });
    else if (type === 'file') pickFiles('*/*', true, (fs) => insertFiles(fs.filter((f) => !/^image\//.test(f.type)).length ? fs : fs.map((f) => new File([f], f.name, { type: 'application/octet-stream' })), afterId));
    else if (type === 'pagelink') pickPage?.().then((pg) => { if (pg) place({ type: 'pagelink', pageId: pg.id, title: pg.title }); });
  }
  function moveBlock(id, dir) { const i = idx(id), j = i + dir; if (j < 0 || j >= B.length) return; const [b] = B.splice(i, 1); B.splice(j, 0, b); const w = wrap(id); if (dir < 0) w.previousElementSibling?.before(w); else w.nextElementSibling?.after(w); renumber(); changed(true); w.scrollIntoView({ block: 'nearest' }); }
  function dupBlock(id) { const b = clone(get(id)); b.id = bid(); delete b._pending; B.splice(idx(id) + 1, 0, b); wrap(id).after(mk(b)); renumber(); changed(true); }

  // ---------- menus ----------
  function closeMenu() { menuEl?.remove(); menuEl = null; slash = null; }
  function popup(items, anchorRect, { onPick, active = 0, cls = '' } = {}) {
    closeMenu(); const m = h('div', { class: `menu ${cls}`, role: 'menu' }, items.map((it, i) => (it.sep ? h('hr') : h('button', { type: 'button', role: 'menuitem', class: i === active ? 'on' : '', onmousedown: (e) => e.preventDefault(), onclick: () => { closeMenu(); (onPick || it.run)(it, i); } }, h('b', {}, it.label), it.hint ? h('small', {}, it.hint) : null))));
    document.body.append(m); const r = m.getBoundingClientRect(), vw = innerWidth, vh = innerHeight; let x = Math.min(anchorRect.left, vw - r.width - 8), y = anchorRect.bottom + 4; if (y + r.height > vh - 8) y = Math.max(8, anchorRect.top - r.height - 4); m.style.left = `${Math.max(8, x)}px`; m.style.top = `${y}px`; menuEl = m; return m;
  }
  function blockMenu(id, anchor) {
    const b = get(id), items = [];
    if (TEXT.includes(b.type)) for (const [l, t] of SLASH.slice(0, 10)) if (t !== b.type) items.push({ label: `Turn into ${l.toLowerCase()}`, run: () => turnInto(id, t) });
    items.push({ sep: true }, { label: 'Add block below', run: () => { const nb = addAfter(id, { type: 'p', html: '' }); focusBlock(nb.id); } }, { label: 'Duplicate', run: () => dupBlock(id) }, { label: 'Move up', run: () => moveBlock(id, -1) }, { label: 'Move down', run: () => moveBlock(id, 1) }, { label: 'Delete', run: () => removeBlock(id) });
    popup(items, anchor.getBoundingClientRect());
  }
  function openSlash(id, q) { const list = SLASH.filter(([l, , hnt]) => !q || l.toLowerCase().includes(q.toLowerCase()) || hnt.includes(q.toLowerCase())); if (!list.length) { closeMenu(); return; } slash = { id, q, i: 0, list }; const t = wrap(id)?.querySelector('.txt'); const r = (t || wrap(id)).getBoundingClientRect(); popup(list.map(([label, type, hint]) => ({ label, hint, type })), r, { cls: 'slash', onPick: (it) => runSlash(id, it.type) }); slash.id = id; paintSlash(); }
  function paintSlash() { menuEl?.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === slash.i)); menuEl?.querySelectorAll('button')[slash.i]?.scrollIntoView({ block: 'nearest' }); }
  function runSlash(id, type) { const b = get(id), t = wrap(id)?.querySelector('.txt'); if (t && b) { const txt = t.textContent.replace(/\/\w*$/, ''); t.textContent = txt; b.html = sanitizeHtml(t.innerHTML); } closeMenu(); insertType(id, type); }

  // ---------- formatting toolbar ----------
  const fmt = (cmd, val) => { if (!inEl(sel().anchorNode) && savedRange) { sel().removeAllRanges(); sel().addRange(savedRange); } document.execCommand('styleWithCSS', false, true); document.execCommand(cmd, false, val); const id = curBlockId(); const t = id && wrap(id)?.querySelector('.txt, td, th, figcaption'); if (t) t.dispatchEvent(new Event('input', { bubbles: true })); syncBar(); };
  const tb = (label, title, fn, cls = '') => h('button', { type: 'button', class: `tbtn ${cls}`, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  let btnUndo, btnRedo; const marks = {};
  function buildBar() {
    btnUndo = tb('↶', 'Undo (Ctrl+Z)', undo); btnRedo = tb('↷', 'Redo (Ctrl+Shift+Z)', redo);
    const mark = (k, label, title, cmd, cls) => (marks[k] = tb(label, title, () => fmt(cmd), cls));
    const turn = h('select', { class: 'tsel', 'aria-label': 'Block type', onchange: (e) => { const id = curBlockId() || selectedId(); if (id && e.target.value) turnInto(id, e.target.value); e.target.value = ''; } }, h('option', { value: '' }, 'Turn into…'), SLASH.slice(0, 9).map(([l, t]) => h('option', { value: t }, l)));
    turn.addEventListener('mousedown', () => { savedRange = sel().rangeCount ? sel().getRangeAt(0).cloneRange() : null; });
    const color = tb('A', 'Text color', (e) => { savedRange = sel().rangeCount && inEl(sel().anchorNode) ? sel().getRangeAt(0).cloneRange() : savedRange; popup(COLORS.map(([label, c]) => ({ label, c })), e.currentTarget.getBoundingClientRect(), { cls: 'colors', onPick: (it) => fmt('foreColor', it.c || '#' + (matchMedia('(prefers-color-scheme: light)').matches ? '111111' : 'f2f2f2')) }); }, 'colorbtn');
    const link = tb('🔗', 'Link', async () => { savedRange = sel().rangeCount && inEl(sel().anchorNode) ? sel().getRangeAt(0).cloneRange() : savedRange; const cur = savedRange?.startContainer?.parentElement?.closest?.('a')?.getAttribute('href') || ''; const url = await ask?.('Link', 'Web address (https://…), or leave empty to remove the link.', cur); if (url === null || url === undefined) return; if (savedRange) { sel().removeAllRanges(); sel().addRange(savedRange); } if (!url.trim()) fmt('unlink'); else { let u = url.trim(); if (!/^(https?:|mailto:|tel:|#\/)/i.test(u)) u = `https://${u}`; fmt('createLink', u); } });
    const pg = tb('📄', 'Link to a page', async () => { savedRange = sel().rangeCount && inEl(sel().anchorNode) ? sel().getRangeAt(0).cloneRange() : savedRange; const p = await pickPage?.(); if (!p) return; if (savedRange) { sel().removeAllRanges(); sel().addRange(savedRange); } if (sel().isCollapsed) document.execCommand('insertHTML', false, `<a href="#/p/${p.id}">${p.title.replace(/[<>&]/g, '')}</a>&nbsp;`); else fmt('createLink', `#/p/${p.id}`); const id = curBlockId(); id && wrap(id)?.querySelector('.txt')?.dispatchEvent(new Event('input', { bubbles: true })); });
    toolbar.replaceChildren(btnUndo, btnRedo, h('span', { class: 'sep' }), mark('b', 'B', 'Bold (Ctrl+B)', 'bold', 'bold'), mark('i', 'I', 'Italic (Ctrl+I)', 'italic', 'ital'), mark('u', 'U', 'Underline (Ctrl+U)', 'underline', 'und'), mark('s', 'S', 'Strikethrough', 'strikeThrough', 'strk'), tb('‹›', 'Inline code', () => { const t = sel().toString(); if (t) { document.execCommand('insertHTML', false, `<code>${t.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</code>`); const id = curBlockId(); id && wrap(id)?.querySelector('.txt')?.dispatchEvent(new Event('input', { bubbles: true })); } }), color, link, pg, h('span', { class: 'sep' }), turn, h('span', { class: 'sep' }),
      tb('🖼', 'Insert image', () => insertAfterCursor('image')), tb('▦', 'Insert table', () => insertAfterCursor('table')), tb('＋', 'Insert block…', (e) => { const id = curBlockId() || B[B.length - 1].id; popup(SLASH.map(([label, type, hint]) => ({ label, hint, type })), e.currentTarget.getBoundingClientRect(), { cls: 'slash', onPick: (it) => insertType(id, it.type) }); }));
    syncBar();
  }
  const insertAfterCursor = (type) => insertType(curBlockId() || selectedId() || B[B.length - 1].id, type);
  function syncBar() { if (!btnUndo) return; btnUndo.disabled = hi <= 0; btnRedo.disabled = hi >= hist.length - 1; for (const [k, cmd] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['s', 'strikeThrough']]) { let on = false; try { on = inEl(sel().anchorNode) && document.queryCommandState(cmd); } catch { /* not supported */ } marks[k]?.classList.toggle('on', !!on); } }
  document.addEventListener('selectionchange', syncBar);

  // ---------- block selection ----------
  const selectedId = () => [...selected][0] || null;
  function selectBlocks(ids) { selected = new Set(ids); el.querySelectorAll('.blk.sel').forEach((n) => n.classList.remove('sel')); ids.forEach((i) => wrap(i)?.classList.add('sel')); if (ids.length) { document.activeElement?.blur?.(); el.focus({ preventScroll: true }); } }
  el.tabIndex = -1;
  const clearSel = () => { if (selected.size) { selected.clear(); el.querySelectorAll('.blk.sel').forEach((n) => n.classList.remove('sel')); } };
  const copyBlocks = (ids) => ids.map((i) => clone(get(i))).filter(Boolean);

  // ---------- events ----------
  function textInput(e) {
    const t = e.target; const w = t.closest('.blk'); if (!w || !t.classList.contains('txt')) return; const b = get(w.dataset.id); if (!b) return;
    if (b.type === 'code') b.html = t.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;'); else b.html = sanitizeHtml(t.innerHTML);
    const plain = t.textContent.replace(/\u00a0/g, ' ');
    if (b.type === 'p') { const m = /^(#{1,3}|-|\*|\d+\.|\[\]|>) $/.exec(plain); if (m) { const map = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '[]': 'todo', '>': 'quote' }; const ty = /^\d+\.$/.test(m[1]) ? 'ol' : map[m[1]]; b.html = ''; turnInto(b.id, ty); return; } }
    const sm = /(?:^|\s)\/(\w*)$/.exec(plain.slice(0, (() => { const s = sel(); if (!s.rangeCount) return plain.length; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(t); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString().length; })()));
    if (sm && b.type !== 'code') openSlash(b.id, sm[1]); else if (slash) closeMenu();
    changed();
  }
  function splitAtCaret(t) { const r = sel().getRangeAt(0), post = document.createRange(); post.selectNodeContents(t); post.setStart(r.endContainer, r.endOffset); const d = h('div'); d.append(post.extractContents()); return sanitizeHtml(d.innerHTML); }
  el.addEventListener('input', (e) => { if (e.target.classList.contains('txt')) textInput(e); });
  el.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey, t = e.target;
    if (mod && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); (e.key.toLowerCase() === 'y' || e.shiftKey) ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'b' && t.isContentEditable) { e.preventDefault(); fmt('bold'); return; } if (mod && e.key.toLowerCase() === 'i' && t.isContentEditable) { e.preventDefault(); fmt('italic'); return; } if (mod && e.key.toLowerCase() === 'u' && t.isContentEditable) { e.preventDefault(); fmt('underline'); return; }
    if (mod && e.key.toLowerCase() === 'k' && t.isContentEditable) { e.preventDefault(); toolbar.querySelector('[aria-label=Link]')?.click(); return; }
    if (mod && e.key.toLowerCase() === 'd' && selected.size === 1) { e.preventDefault(); dupBlock(selectedId()); return; }
    if (slash && menuEl) { if (e.key === 'ArrowDown') { e.preventDefault(); slash.i = (slash.i + 1) % slash.list.length; paintSlash(); return; } if (e.key === 'ArrowUp') { e.preventDefault(); slash.i = (slash.i + slash.list.length - 1) % slash.list.length; paintSlash(); return; } if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slash.id, slash.list[slash.i][1]); return; } if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; } }
    if (selected.size && !t.isContentEditable) { // block-selection mode
      const ids = [...selected], i0 = Math.min(...ids.map(idx)), i1 = Math.max(...ids.map(idx));
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const at = B[Math.max(0, i0 - 1)]?.id; ids.forEach(removeBlock); selected.clear(); const f = B.find((b) => b.id === at) || B[0]; focusBlock(f.id, 'end'); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = e.key === 'ArrowDown' ? Math.min(B.length - 1, i1 + 1) : Math.max(0, i0 - 1); if (e.shiftKey) selectBlocks(B.slice(Math.min(i0, j), Math.max(i1, j) + 1).map((b) => b.id)); else selectBlocks([B[j].id]); wrap(B[j].id).scrollIntoView({ block: 'nearest' }); return; }
      if (e.key === 'Enter') { e.preventDefault(); focusBlock(B[i0].id, 'end'); clearSel(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectBlocks(B.map((b) => b.id)); return; }
      if (e.key === 'Escape') { clearSel(); return; }
    }
    if (!t.classList?.contains('txt')) return; const w = t.closest('.blk'), b = get(w.dataset.id); if (!b) return;
    if (e.key === 'Escape') { e.preventDefault(); selectBlocks([b.id]); return; }
    if (mod && e.key.toLowerCase() === 'a' && atStart(t) === false && !sel().isCollapsed === false) { /* native select-all within block first */ }
    if (e.key === 'Enter' && !e.shiftKey && b.type !== 'code') {
      e.preventDefault(); const plain = t.textContent.trim();
      if (b.type === 'p' && plain === '---') { b.html = ''; turnInto(b.id, 'p'); const nb = addAfter(b.id, { type: 'hr' }); const nx = addAfter(nb.id, { type: 'p', html: '' }); removeBlock(b.id); focusBlock(nx.id); return; }
      if (b.type === 'p' && plain === '```') { b.html = ''; turnInto(b.id, 'code'); return; }
      if (!plain && ['ul', 'ol', 'todo'].includes(b.type)) { if (b.indent) { b.indent--; replace(b.id); changed(true); focusBlock(b.id, 'end'); } else turnInto(b.id, 'p'); return; }
      const rest = splitAtCaret(t); b.html = sanitizeHtml(t.innerHTML); const keep = ['ul', 'ol', 'todo'].includes(b.type); const nb = { id: bid(), type: keep ? b.type : 'p', html: rest }; if (keep && b.indent) nb.indent = b.indent; if (b.type === 'todo') nb.checked = false;
      B.splice(idx(b.id) + 1, 0, nb); w.after(mk(nb)); renumber(); changed(true); focusBlock(nb.id, 'start'); return;
    }
    if (e.key === 'Enter' && b.type === 'code' && !e.shiftKey && atEnd(t) && /\n\n?$/.test(t.textContent) && t.textContent.endsWith('\n\n')) { e.preventDefault(); b.html = b.html.replace(/\n+$/, ''); const nb = addAfter(b.id, { type: 'p', html: '' }); replace(b.id); focusBlock(nb.id); return; }
    if (e.key === 'Backspace' && atStart(t)) {
      if (b.type !== 'p') { e.preventDefault(); if (b.indent) { b.indent--; replace(b.id); } else turnInto(b.id, 'p'); changed(true); focusBlock(b.id, 'start'); return; }
      const i = idx(b.id), prev = B[i - 1]; if (!prev) return; e.preventDefault();
      if (TEXT.includes(prev.type) && prev.type !== 'code') { const len = htmlToText(prev.html).length; prev.html = sanitizeHtml(prev.html + b.html); B.splice(i, 1); w.remove(); replace(prev.id); renumber(); changed(true); focusBlock(prev.id, len); }
      else if (!htmlToText(b.html).trim()) { removeBlock(b.id); selectBlocks([prev.id]); } else selectBlocks([prev.id]);
      return;
    }
    if (e.key === 'Delete' && atEnd(t)) { const i = idx(b.id), nx = B[i + 1]; if (nx && TEXT.includes(nx.type) && nx.type !== 'code' && b.type !== 'code') { e.preventDefault(); const len = htmlToText(b.html).length; b.html = sanitizeHtml(b.html + nx.html); wrap(nx.id).remove(); B.splice(i + 1, 1); replace(b.id); changed(true); focusBlock(b.id, len); } return; }
    if (e.key === 'Tab' && ['ul', 'ol', 'todo'].includes(b.type)) { e.preventDefault(); b.indent = Math.max(0, Math.min(5, (b.indent || 0) + (e.shiftKey ? -1 : 1))); replace(b.id); changed(true); focusBlock(b.id, 'end'); return; }
    if (e.key === 'Tab' && b.type === 'code') { e.preventDefault(); document.execCommand('insertText', false, '  '); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && atStart(t) && !e.shiftKey) { const p = B[idx(b.id) - 1]; if (p) { e.preventDefault(); TEXT.includes(p.type) ? focusBlock(p.id, 'end') : selectBlocks([p.id]); } }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && atEnd(t) && !e.shiftKey) { const n = B[idx(b.id) + 1]; if (n) { e.preventDefault(); TEXT.includes(n.type) ? focusBlock(n.id, 'start') : selectBlocks([n.id]); } }
  });
  el.addEventListener('focusin', (e) => { if (e.target.isContentEditable) clearSel(); });
  el.addEventListener('click', (e) => { const a = e.target.closest?.('a'); if (a && el.contains(a) && !a.classList.contains('plink') && !a.classList.contains('filecard')) { const href = a.getAttribute('href') || ''; if (href.startsWith('#/p/')) { e.preventDefault(); openPage?.(href.slice(4)); } else if (/^(https?:|mailto:|tel:)/i.test(href) && (e.ctrlKey || e.metaKey || !a.closest('[contenteditable=true]') || sel().isCollapsed)) { e.preventDefault(); window.open(href, '_blank', 'noopener'); } } if (!e.target.closest('.blk') && e.target === el) { const last = B[B.length - 1]; if (TEXT.includes(last.type) && !htmlToText(last.html)) focusBlock(last.id, 'end'); else { const nb = addAfter(last.id, { type: 'p', html: '' }); focusBlock(nb.id); } } if (!e.target.closest('.imgfig, .gut') && !e.target.closest('.menu')) clearSel(); });
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  el.addEventListener('paste', (e) => {
    const cd = e.clipboardData; if (!cd) return; const files = [...cd.files]; const pb = cd.getData('application/x-pulsar-blocks');
    if (files.length) { e.preventDefault(); insertFiles(files); return; }
    if (pb) { e.preventDefault(); try { const arr = JSON.parse(pb); let at = curBlockId() || selectedId() || B[B.length - 1].id; for (const x of arr) { const nb = addAfter(at, { ...x, id: undefined }); at = nb.id; } } catch { notify('Could not paste blocks', true); } return; }
    const t = e.target; if (!t.isContentEditable) return; e.preventDefault(); const html = cd.getData('text/html'), text = cd.getData('text/plain');
    if (t.classList.contains('txt') && !html && /\n\s*\n|\n/.test(text.trim()) && t.closest('.blk') && get(t.closest('.blk').dataset.id)?.type !== 'code') { const lines = text.replace(/\r/g, '').split(/\n+/).filter((l) => l.trim()); const w = t.closest('.blk'); document.execCommand('insertText', false, lines[0]); let at = w.dataset.id; for (const l of lines.slice(1)) at = addAfter(at, { type: 'p', html: sanitizeHtml(l.replace(/&/g, '&amp;').replace(/</g, '&lt;')) }).id; return; }
    if (html && !t.closest('.b-code')) document.execCommand('insertHTML', false, sanitizeHtml(html.replace(/<(?:meta|style|script)[^>]*>[\s\S]*?(?:<\/(?:style|script)>)?/gi, '').replace(/<\/(p|div|li|h[1-6])>/gi, '<br>').replace(/^(<br>)+|(<br>)+$/g, ''))); else document.execCommand('insertText', false, text);
  });
  el.addEventListener('copy', (e) => { if (selected.size && !document.activeElement?.isContentEditable) { e.preventDefault(); const ids = B.filter((b) => selected.has(b.id)).map((b) => b.id); e.clipboardData.setData('application/x-pulsar-blocks', JSON.stringify(copyBlocks(ids))); e.clipboardData.setData('text/plain', ids.map((i) => htmlToText(get(i).html || '')).join('\n')); } });
  el.addEventListener('cut', (e) => { if (selected.size && !document.activeElement?.isContentEditable) { e.preventDefault(); const ids = B.filter((b) => selected.has(b.id)).map((b) => b.id); e.clipboardData.setData('application/x-pulsar-blocks', JSON.stringify(copyBlocks(ids))); ids.forEach(removeBlock); selected.clear(); } });
  // drag & drop: reorder blocks, or drop image files between blocks
  const clearDrop = () => el.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  const dropTarget = (e) => { const w = e.target.closest?.('.blk'); if (!w) return null; const r = w.getBoundingClientRect(); return { w, after: e.clientY > r.top + r.height / 2 }; };
  el.addEventListener('dragover', (e) => { const types = [...(e.dataTransfer?.types || [])]; if (!types.includes('application/x-pulsar-block') && !types.includes('Files')) return; e.preventDefault(); clearDrop(); const d = dropTarget(e); if (d) d.w.classList.add(d.after ? 'drop-after' : 'drop-before'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clearDrop(); });
  el.addEventListener('drop', (e) => {
    const d = dropTarget(e), dt = e.dataTransfer; clearDrop(); if (!dt) return; const id = dt.getData('application/x-pulsar-block');
    if (id && d) { e.preventDefault(); const tid = d.w.dataset.id; if (tid === id) return; const i = idx(id), [b] = B.splice(i, 1), j = idx(tid) + (d.after ? 1 : 0); B.splice(j, 0, b); const node = wrap(id); d.after ? d.w.after(node) : d.w.before(node); renumber(); changed(true); return; }
    if (dt.files?.length) { e.preventDefault(); const tid = d ? (d.after ? d.w.dataset.id : B[Math.max(0, idx(d.w.dataset.id) - 1)].id) : B[B.length - 1].id; insertFiles([...dt.files], d && !d.after && idx(d.w.dataset.id) === 0 ? null : tid); }
  });
  window.addEventListener('beforeprint', () => closeMenu());

  renderAll(); if (!readOnly) buildBar(); else toolbar.hidden = true;
  return { el, toolbar, getBlocks: () => clean(), setBlocks(nb) { B = clone(nb); if (!B.length) B = [{ id: bid(), type: 'p', html: '' }]; hist = [JSON.stringify(B)]; hi = 0; renderAll(); syncBar(); }, undo, redo, insertFiles, focusEnd() { const last = B[B.length - 1]; focusBlock(last.id, 'end'); }, focusStart() { focusBlock(B[0].id, 'end'); }, destroy() { closeMenu(); document.removeEventListener('selectionchange', syncBar); },
    pending: () => B.some((b) => b._pending === true), snapshot: snap };
}
