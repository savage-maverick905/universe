import { api, h, toast, B } from './services/api.js';
import { createUploader, thumbUrl } from './services/media.js';
import { icon } from '/shared/icons.js';

const root = document.getElementById('app');
const S = { meta: null, cats: [], locs: [], items: [], total: 0, f: { q: '', status: '', category: '', sort: 'updatedAt', dir: 'desc', archived: false } };
const name = (list, id) => list.find((x) => x.id === id)?.name ?? '';
const lab = (list, id) => list.find((x) => x.id === id)?.label ?? id ?? '';
const warnStates = ['lost', 'stolen', 'damaged', 'under_repair'];
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

function dialog(title, ...content) {
  const d = h('dialog', {}, h('div', { class: 'sheet' }, h('h2', {}, title), ...content));
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap outside to close
  document.body.append(d); d.showModal();
  return d;
}
// Closes whichever dialog holds the button, so it can be created before the dialog exists.
const closer = () => h('button', { type: 'button', class: 'btn ghost', onclick: (e) => e.currentTarget.closest('dialog').close() }, 'Close');

async function refresh() {
  const f = S.f, qs = new URLSearchParams({ sort: f.sort, dir: f.dir, archived: f.archived });
  for (const k of ['q', 'status', 'category']) if (f[k]) qs.set(k, f[k]);
  const [list, c, l] = await Promise.all([api('GET', `/items?${qs}`), api('GET', '/categories'), api('GET', '/locations')]);
  Object.assign(S, { items: list.items, total: list.total, cats: c.categories, locs: l.locations });
  renderList();
}

function itemRow(it) {
  const img = it.media.images[0];
  const st = it.status.state;
  return h('button', { class: 'item', onclick: () => showItem(it.id) },
    img ? h('img', { class: 'thumb', src: thumbUrl(img.secureUrl), alt: '', loading: 'lazy' }) : h('div', { class: 'thumb', 'aria-hidden': 'true' }, it.identity.name[0].toUpperCase()),
    h('div', {}, h('b', {}, it.identity.name), h('small', {}, [name(S.cats, it.identity.categoryId), name(S.locs, it.location.locationId)].filter(Boolean).join(', ') || 'No category or location')),
    h('span', { class: `badge${warnStates.includes(st) ? ' warn' : ''}` }, lab(S.meta.statuses, st)));
}
let listEl, countEl;
function renderList() {
  if (!listEl) return; // refresh() runs once before shell() has built the page
  const filtered = S.f.q || S.f.status || S.f.category;
  const rows = S.items.length ? S.items.map(itemRow) : [h('div', { class: 'empty' }, icon('box'),
    h('div', {}, filtered ? 'No items match these filters.' : S.f.archived ? 'No archived items.' : 'Nothing here yet.'),
    filtered || S.f.archived ? null : h('button', { class: 'btn small', onclick: () => editItem() }, icon('plus'), 'Add your first item'))];
  listEl.replaceChildren(...rows);
  if (countEl) countEl.textContent = S.total === 1 ? '1 item' : `${S.total} items`;
}

function sel(options, value, onchange, label) {
  return h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value ? '' : null }, t)));
}
function shell() {
  const f = S.f;
  listEl = h('div', { class: 'list' });
  countEl = h('p', { class: 'count', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', placeholder: 'Search items', 'aria-label': 'Search items', value: f.q });
  let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { f.q = search.value; refresh(); }, 250); });
  const set = (k) => (v) => { f[k] = v; refresh(); };
  const importInput = h('input', { type: 'file', accept: 'application/json', hidden: '', onchange: async (e) => {
    try { const r = await api('POST', '/import', JSON.parse(await e.target.files[0].text())); toast(`Imported ${r.imported.items} items`); await refresh(); } catch (x) { toast(x.message); }
    e.target.value = '';
  } });
  root.replaceChildren(h('main', { class: 'wrap' },
    h('div', { class: 'head' }, h('a', { href: '/', class: 'back', 'aria-label': 'Back to Universe' }, icon('back')), h('h1', {}, 'Inventory'),
      h('button', { class: 'btn', onclick: () => editItem() }, icon('plus'), 'Add item')),
    h('div', { class: 'tools' }, h('div', { class: 'search' }, icon('search'), search),
      sel([['', 'Any status'], ...S.meta.statuses.map((s) => [s.id, s.label])], f.status, set('status'), 'Filter by status'),
      sel([['', 'Any category'], ...S.cats.map((c) => [c.id, c.name])], f.category, set('category'), 'Filter by category'),
      sel([['updatedAt|desc', 'Recent'], ['createdAt|desc', 'Newest'], ['name|asc', 'Name A to Z'], ['price|desc', 'Highest price']], `${f.sort}|${f.dir}`, (v) => { [f.sort, f.dir] = v.split('|'); refresh(); }, 'Sort'),
      sel([['false', 'Active items'], ['true', 'Archived items']], String(f.archived), (v) => { f.archived = v === 'true'; refresh(); }, 'Show')),
    countEl, listEl,
    h('div', { class: 'row footer-actions' }, h('button', { class: 'btn ghost small', onclick: organize }, icon('folder'), 'Categories and locations'),
      h('a', { class: 'btn ghost small', href: `${B}/export`, download: 'universe-inventory.json' }, icon('download'), 'Export JSON'),
      h('button', { class: 'btn ghost small', onclick: () => importInput.click() }, icon('upload'), 'Import JSON'), importInput)));
  renderList();
}

// ---------- view ----------
async function showItem(id) {
  const { item: it } = await api('GET', `/items/${id}`);
  const rel = [...(it.relationships.parentItemId ? [it.relationships.parentItemId] : []), ...it.relationships.relatedItems];
  const names = await Promise.all(rel.map((r) => api('GET', `/items/${r}`).then((x) => x.item.identity.name).catch(() => null)));
  const kv = [['Status', `${lab(S.meta.statuses, it.status.state)}${it.status.reason ? `: ${it.status.reason}` : ''}`], ['Condition', `${lab(S.meta.conditions, it.condition.state)} ${it.condition.notes}`.trim()],
    ['Category', name(S.cats, it.identity.categoryId)], ['Location', name(S.locs, it.location.locationId)], ['Tags', it.identity.tags.join(', ')], ['Acquired', [lab(S.meta.acquisitionMethods, it.acquisition.method), it.acquisition.date, it.acquisition.source].filter(Boolean).join(', ')],
    ['Price', it.acquisition.price != null ? `${it.acquisition.currency || ''} ${it.acquisition.price.toLocaleString('en-US')}`.trim() : ''], ['Brand and model', [it.identification.brand, it.identification.model].filter(Boolean).join(' ')],
    ['Model number', it.identification.modelNumber], ['Serial number', it.identification.serialNumber], ['IMEI', it.identification.imei], ['Related', names.filter(Boolean).join(', ')], ['Notes', it.notes]].filter(([, v]) => v);
  const d = dialog(it.identity.name, it.identity.description ? h('p', {}, it.identity.description) : null,
    h('div', { class: 'imgs' }, it.media.images.map((m) => h('a', { href: m.secureUrl, target: '_blank', rel: 'noopener' }, h('img', { src: thumbUrl(m.secureUrl, 200), alt: it.identity.name })))),
    h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('h3', {}, 'History'),
    h('ul', { class: 'hist' }, [...it.history].reverse().map((e) => h('li', {}, `${e.date}: ${e.event.replace(/_/g, ' ')}${e.from || e.to ? ` (${e.from ?? 'none'} to ${e.to ?? 'none'})` : ''}${e.reason ? `, ${e.reason}` : ''}`))),
    h('div', { class: 'row actions' },
      h('button', { class: 'btn small', onclick: () => { d.close(); editItem(it); } }, icon('pencil'), 'Edit'),
      h('button', { class: 'btn ghost small', onclick: async () => { const r = prompt('Add a note to the history'); if (r) { await api('POST', `/items/${it.id}/history`, { reason: r }); d.close(); showItem(it.id); } } }, 'Add history note'),
      h('button', { class: 'btn ghost small', onclick: async () => { await api('POST', `/items/${it.id}/${it.archived ? 'restore' : 'archive'}`); d.close(); toast(it.archived ? 'Item restored' : 'Item archived'); refresh(); } }, it.archived ? 'Restore' : 'Archive'),
      it.archived ? h('button', { class: 'btn ghost small danger', onclick: async () => { if (confirm(`Permanently delete "${it.identity.name}"? This cannot be undone.`)) { await api('DELETE', `/items/${it.id}`); d.close(); toast('Item deleted'); refresh(); } } }, 'Delete permanently') : null,
      closer()));
}

// ---------- add / edit ----------
const opts = (l) => l.map((x) => [x.id, x.label ?? x.name]);
function sections() {
  const none = (t, l) => [['', t], ...opts(l)];
  return [['Basics', true, [['identity.name', 'Name', 'text', { required: '' }], ['identity.description', 'Description', 'textarea'], ['identity.categoryId', 'Category', none('No category', S.cats)], ['identity.tags', 'Tags, separated by commas', 'tags']]],
    ['Status and condition', false, [['status.state', 'Status', opts(S.meta.statuses)], ['status.reason', 'Reason for this status', 'text'], ['condition.state', 'Condition', opts(S.meta.conditions)], ['condition.notes', 'Condition notes', 'text']]],
    ['Location', false, [['location.locationId', 'Where it is', none('Not set', S.locs)]]],
    ['Acquisition', false, [['acquisition.method', 'How you got it', none('Not set', S.meta.acquisitionMethods)], ['acquisition.date', 'Date', 'date'], ['acquisition.source', 'Source', 'text'], ['acquisition.price', 'Price', 'number'], ['acquisition.currency', 'Currency, for example NGN', 'text']]],
    ['Identification', false, ['brand', 'model', 'modelNumber', 'serialNumber', 'imei'].map((k) => [`identification.${k}`, k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), 'text'])],
    ['Notes', false, [['notes', 'Notes', 'textarea']]]];
}
async function editItem(it) {
  const cur = it || {}; const images = [...(get(cur, 'media.images') || [])];
  const others = (await api('GET', '/items?limit=500')).items.filter((x) => x.id !== cur.id);
  const err = h('p', { class: 'err', role: 'alert' });
  const inputs = [];
  const secs = sections().map(([title, open, fields]) => h('details', { open: open ? '' : null }, h('summary', {}, title), fields.map(([path, label, type, extra]) => {
    const v = get(cur, path);
    const el = Array.isArray(type) ? h('select', {}, type.map(([val, t]) => h('option', { value: val, selected: String(val) === String(v ?? (path === 'identity.categoryId' ? '' : '')) ? '' : null }, t)))
      : type === 'textarea' ? h('textarea', { rows: 3 }, v ?? '') : h('input', { type: type === 'tags' ? 'text' : type, step: type === 'number' ? 'any' : null, value: type === 'tags' ? (v || []).join(', ') : v ?? '', ...(extra || {}) });
    if (Array.isArray(type) && !cur.id) { if (path === 'status.state') el.value = 'in_use'; if (path === 'condition.state') el.value = 'good'; }
    inputs.push([path, type, el]);
    return h('label', {}, label, el);
  })));
  const parent = h('select', {}, [['', 'None'], ...others.map((x) => [x.id, x.identity.name])].map(([v, t]) => h('option', { value: v, selected: v === (cur.relationships?.parentItemId ?? '') ? '' : null }, t)));
  const related = h('select', { multiple: '', size: 4 }, others.map((x) => h('option', { value: x.id, selected: (cur.relationships?.relatedItems || []).includes(x.id) ? '' : null }, x.identity.name)));
  const imgBox = h('div', { class: 'imgs' });
  const uploader = createUploader(S.meta.cloudinary);
  const drawImgs = () => imgBox.replaceChildren(...images.map((m, i) => h('a', { href: '#', title: 'Remove image', onclick: (e) => { e.preventDefault(); images.splice(i, 1); drawImgs(); } }, h('img', { src: thumbUrl(m.secureUrl, 168), alt: 'Attached image. Select to remove.' }))));
  drawImgs();
  const file = h('input', { type: 'file', accept: 'image/*', multiple: '', disabled: uploader ? null : '', onchange: async (e) => {
    for (const f of e.target.files) { try { err.textContent = 'Uploading image…'; if (images.length >= 10) throw new Error('At most 10 images per item'); images.push(await uploader.upload(f)); drawImgs(); err.textContent = ''; } catch (x) { err.textContent = x.message; } }
    e.target.value = '';
  } });
  const d = dialog(it ? 'Edit item' : 'Add item', h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const body = { relationships: { parentItemId: parent.value || null, relatedItems: [...related.selectedOptions].map((o) => o.value) }, media: { images } };
    for (const [path, type, el] of inputs) {
      const [sec, key] = path.includes('.') ? path.split('.') : [path];
      const val = type === 'tags' ? el.value.split(',').map((t) => t.trim()).filter(Boolean) : type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
      if (key) (body[sec] ||= {})[key] = val; else body[sec] = val;
    }
    try { const r = await (cur.id ? api('PATCH', `/items/${cur.id}`, body) : api('POST', '/items', body)); d.close(); toast(cur.id ? 'Changes saved' : 'Item added'); await refresh(); showItem(r.item.id); }
    catch (x) { err.textContent = x.message; }
  } }, secs,
  h('details', {}, h('summary', {}, 'Photos'), uploader ? h('label', {}, 'Add photos', file) : h('p', { class: 'muted' }, 'Photo upload is off. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET on the server.'), imgBox),
  h('details', {}, h('summary', {}, 'Related items'), h('label', {}, 'Part of', parent), h('label', {}, 'Related to (hold Ctrl or Cmd to select several)', related)),
  err, h('div', { class: 'row actions' }, h('button', { class: 'btn' }, 'Save item'), closer())));
}

// ---------- categories and locations ----------
function organize() {
  const box = h('div', {}); const d = dialog('Categories and locations', box); d.firstChild.append(h('div', { class: 'row actions' }, closer()));
  const draw = () => {
    const section = (title, path, list, key, parented) => h('section', {}, h('h3', {}, title),
      h('ul', { class: 'manage' }, list.map((x) => h('li', {}, h('span', {}, `${parented && x.parentId ? `${name(list, x.parentId)} / ` : ''}${x.name}`),
        h('span', { class: 'acts' },
          h('button', { class: 'btn ghost small', onclick: async () => { const n = prompt('New name', x.name); if (n) await run(() => api('PATCH', `/${path}/${x.id}`, { name: n })); } }, 'Rename'),
          h('button', { class: 'btn ghost small danger', onclick: () => run(() => api('DELETE', `/${path}/${x.id}`)) }, 'Delete'))))),
      (() => { const i = h('input', { placeholder: `New ${key}`, 'aria-label': `New ${key} name` }); const p = parented ? sel([['', 'Top level'], ...list.map((l) => [l.id, `Inside ${l.name}`])], '', () => {}, 'Parent location') : null;
        return h('div', { class: 'row add-row' }, i, p, h('button', { class: 'btn small', onclick: () => i.value && run(() => api('POST', `/${path}`, { name: i.value, ...(p?.value ? { parentId: p.value } : {}) })) }, `Add ${key}`)); })());
    box.replaceChildren(section('Categories', 'categories', S.cats, 'category', false), section('Locations', 'locations', S.locs, 'location', true));
  };
  const run = async (fn) => { try { await fn(); await refresh(); draw(); } catch (x) { toast(x.message); } };
  draw();
}

(async () => {
  try { S.meta = await api('GET', '/meta'); await refresh(); shell(); }
  catch (x) { root.replaceChildren(h('main', { class: 'wrap' }, h('h1', {}, 'Inventory'), h('p', { class: 'muted' }, `Inventory could not load: ${x.message}`), h('a', { class: 'btn', href: '/' }, 'Back to dashboard'))); }
})();
