import { api, h, toast, B, setUnauthorizedHandler } from './services/api.js';
import { createUploader, thumbUrl } from './services/media.js';
import { icon } from '/shared/icons.js';
import { dialog, closer, initial, api as rootApi } from '/shared/ui.js';
import { showAuth } from '/shared/auth.js';
import { accountPanels } from '/shared/account.js';
import { renderWidget } from '/shared/widgets.js';
import { registerServiceWorker, canPromptInstall, promptInstall, onInstallChange, isStandalone } from '/shared/pwa.js';

const root = document.getElementById('app');
const S = { meta: null, cats: [], locs: [], items: [], total: 0, f: { q: '', status: '', category: '', sort: 'updatedAt', dir: 'desc', archived: false } };
let me = null;
const name = (list, id) => list.find((x) => x.id === id)?.name ?? '';
const lab = (list, id) => list.find((x) => x.id === id)?.label ?? id ?? '';
const warnStates = ['lost', 'stolen', 'damaged', 'under_repair'];
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

// Inventory is its own installable app: it has its own sign-in, navigation and settings.
registerServiceWorker('/apps/inventory/sw.js', '/apps/inventory/');
const brand = { name: 'Inventory', blurb: 'Track the things you own.', mark: () => h('div', { class: 'mark inv', 'aria-hidden': 'true' }, icon('box')) };
setUnauthorizedHandler(() => { if (me) { me = null; boot('Your session ended. Sign in again.'); } });
const signOut = () => { me = null; boot(); };

const NAV = [['#/', 'Items', 'items', 'box'], ['#/overview', 'Overview', 'overview', 'chart'], ['#/organize', 'Organize', 'organize', 'folder'], ['#/settings', 'Settings', 'settings', 'settings']];
function frame(page, ...content) {
  const link = ([href, label, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, label));
  const install = h('button', { class: 'btn ghost small', hidden: '', title: 'Install Inventory', 'aria-label': 'Install Inventory', onclick: promptInstall }, icon('download'), h('span', { class: 'lbl' }, 'Install'));
  const syncInstall = () => { install.hidden = isStandalone() || !canPromptInstall(); };
  syncInstall(); onInstallChange(syncInstall);
  root.replaceChildren(
    h('header', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Inventory home' }, brand.mark(), h('span', { class: 'brand-text' }, h('b', {}, 'Inventory'), h('small', {}, 'Hie Technologies'))),
      h('nav', { 'aria-label': 'Main' }, NAV.map(link)),
      h('div', { class: 'me' }, h('span', { class: 'who' }, me.user.displayName), install,
        h('button', { class: 'btn ghost small', 'aria-label': 'Sign out', title: 'Sign out', onclick: async () => { try { await rootApi('POST', '/api/auth/logout'); } catch { /* already out */ } signOut(); } }, icon('logout'), h('span', { class: 'lbl' }, 'Sign out')))),
    h('main', { class: 'main' }, h('div', { class: 'wrap' }, ...content)));
  window.scrollTo(0, 0);
}

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
  if (!listEl) return; // refresh() can run before the page has been built
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
async function itemsPage() {
  const f = S.f;
  listEl = h('div', { class: 'list' });
  countEl = h('p', { class: 'count', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', placeholder: 'Search items', 'aria-label': 'Search items', value: f.q });
  let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { f.q = search.value; refresh(); }, 250); });
  const set = (k) => (v) => { f[k] = v; refresh(); };
  await refresh();
  frame('items',
    h('div', { class: 'page-head' }, h('h1', {}, 'Items'), h('button', { class: 'btn', onclick: () => editItem() }, icon('plus'), 'Add item')),
    h('div', { class: 'tools' }, h('div', { class: 'search' }, icon('search'), search),
      sel([['', 'Any status'], ...S.meta.statuses.map((s) => [s.id, s.label])], f.status, set('status'), 'Filter by status'),
      sel([['', 'Any category'], ...S.cats.map((c) => [c.id, c.name])], f.category, set('category'), 'Filter by category'),
      sel([['updatedAt|desc', 'Recent'], ['createdAt|desc', 'Newest'], ['name|asc', 'Name A to Z'], ['price|desc', 'Highest price']], `${f.sort}|${f.dir}`, (v) => { [f.sort, f.dir] = v.split('|'); refresh(); }, 'Sort'),
      sel([['false', 'Active items'], ['true', 'Archived items']], String(f.archived), (v) => { f.archived = v === 'true'; refresh(); }, 'Show')),
    countEl, listEl);
  renderList();
}

async function overviewPage() {
  const specs = [['Summary', 'stat', 'summary'], ['Items by category', 'chart', 'by-category'], ['Items by location', 'chart', 'by-location'], ['Recently added', 'list', 'recent']];
  const cards = specs.map(([title, type, ep]) => {
    const body = h('p', { class: 'muted' }, 'Loading…');
    api('GET', `/stats/${ep}`).then((d) => body.replaceWith(renderWidget(type, d))).catch((x) => { body.textContent = x.message; });
    return h('article', { class: 'card' }, h('h3', {}, title), body);
  });
  frame('overview', h('div', { class: 'page-head' }, h('h1', {}, 'Overview')), h('div', { class: 'grid' }, cards));
}

function settingsPage() {
  const importInput = h('input', { type: 'file', accept: 'application/json', hidden: '', onchange: async (e) => {
    try { const r = await api('POST', '/import', JSON.parse(await e.target.files[0].text())); toast(`Imported ${r.imported.items} items`); } catch (x) { toast(x.message); }
    e.target.value = '';
  } });
  const data = h('section', { class: 'panel' }, h('h2', {}, 'Your data'),
    h('p', { class: 'sub' }, 'Download everything in your inventory as a file, or load a file you exported earlier.'),
    h('div', { class: 'row', style: 'margin-top:0' },
      h('a', { class: 'btn ghost small', href: `${B}/export`, download: 'universe-inventory.json' }, icon('download'), 'Export JSON'),
      h('button', { class: 'btn ghost small', onclick: () => importInput.click() }, icon('upload'), 'Import JSON'), importInput));
  const [profile, password, install, session] = accountPanels({ session: me, appName: 'Inventory', onSignOut: signOut });
  frame('settings', h('div', { class: 'settings' }, h('h1', { class: 'page-title' }, 'Settings'), profile, password, data, install, session));
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
  const upStatus = h('p', { class: 'up-status', role: 'status' });
  const drawImgs = () => imgBox.replaceChildren(...images.map((m, i) => h('div', { class: 'img-tile' }, h('img', { src: thumbUrl(m.secureUrl, 168), alt: `Photo ${i + 1}` }),
    h('button', { type: 'button', class: 'img-del', 'aria-label': `Remove photo ${i + 1}`, onclick: () => { images.splice(i, 1); drawImgs(); } }, icon('x', 14)))));
  drawImgs();
  const file = h('input', { type: 'file', accept: 'image/*', multiple: '', disabled: uploader ? null : '', onchange: async (e) => {
    const files = [...e.target.files]; e.target.value = ''; upStatus.className = 'up-status';
    let done = 0;
    for (const [n, f] of files.entries()) {
      try {
        if (images.length >= 10) throw new Error('At most 10 photos per item');
        images.push(await uploader.upload(f, (t) => { upStatus.textContent = `${files.length > 1 ? `Photo ${n + 1} of ${files.length}: ` : ''}${t}`; })); drawImgs(); done++;
      } catch (x) { upStatus.className = 'up-status bad'; upStatus.textContent = x.message; return; }
    }
    upStatus.textContent = `${done} photo${done === 1 ? '' : 's'} added. Save the item to keep ${done === 1 ? 'it' : 'them'}.`;
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
  h('details', {}, h('summary', {}, 'Photos'), uploader ? h('label', {}, 'Add photos', file) : h('p', { class: 'muted' }, 'Photo upload is off. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET on the server.'), upStatus, imgBox),
  h('details', {}, h('summary', {}, 'Related items'), h('label', {}, 'Part of', parent), h('label', {}, 'Related to (hold Ctrl or Cmd to select several)', related)),
  err, h('div', { class: 'row actions' }, h('button', { class: 'btn' }, 'Save item'), closer())));
}

// ---------- categories and locations ----------
async function organizePage() {
  await refresh();
  const box = h('div', {});
  const draw = () => {
    const section = (title, path, list, key, parented) => h('section', { class: 'panel' }, h('h2', {}, title),
      list.length ? h('ul', { class: 'manage' }, list.map((x) => h('li', {}, h('span', {}, `${parented && x.parentId ? `${name(list, x.parentId)} / ` : ''}${x.name}`),
        h('span', { class: 'acts' },
          h('button', { class: 'btn ghost small', onclick: async () => { const n = prompt('New name', x.name); if (n) await run(() => api('PATCH', `/${path}/${x.id}`, { name: n })); } }, 'Rename'),
          h('button', { class: 'btn ghost small danger', onclick: () => run(() => api('DELETE', `/${path}/${x.id}`)) }, 'Delete'))))) : h('p', { class: 'muted' }, `No ${key}s yet.`),
      (() => { const i = h('input', { placeholder: `New ${key}`, 'aria-label': `New ${key} name` }); const p = parented ? sel([['', 'Top level'], ...list.map((l) => [l.id, `Inside ${l.name}`])], '', () => {}, 'Parent location') : null;
        return h('div', { class: 'row add-row' }, i, p, h('button', { class: 'btn small', onclick: () => i.value && run(() => api('POST', `/${path}`, { name: i.value, ...(p?.value ? { parentId: p.value } : {}) })) }, `Add ${key}`)); })());
    box.replaceChildren(section('Categories', 'categories', S.cats, 'category', false), section('Locations', 'locations', S.locs, 'location', true));
  };
  const run = async (fn) => { try { await fn(); await refresh(); draw(); } catch (x) { toast(x.message); } };
  draw();
  frame('organize', h('div', { class: 'page-head' }, h('h1', {}, 'Organize')), h('p', { class: 'sub' }, 'Categories and places to keep your items sorted.'), box);
}

async function route() {
  try {
    const hash = location.hash;
    if (hash === '#/overview') await overviewPage();
    else if (hash === '#/organize') await organizePage();
    else if (hash === '#/settings') settingsPage();
    else if (hash === '#/new') { await itemsPage(); history.replaceState(null, '', '#/'); editItem(); }
    else await itemsPage();
  } catch (x) { if (x.status !== 401) toast(x.message); }
}

async function boot(note = '') {
  try { me = await rootApi('GET', '/api/auth/me'); }
  catch { me = await showAuth({ root, brand, note }); }
  try { S.meta = await api('GET', '/meta'); }
  catch (x) {
    if (x.status === 401) return;
    frame('items', h('h1', {}, 'Inventory'), h('p', { class: 'muted' }, x.status === 403 ? 'Your account does not have access to Inventory yet. Ask an admin to give you access.' : `Inventory could not load: ${x.message}`),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')));
    return;
  }
  await route();
}
addEventListener('hashchange', () => me && S.meta && route());
boot();
