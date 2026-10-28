import '/shared/select.js';
import { api as rootApi } from '/shared/ui.js';
import { icon } from '/shared/icons.js';
import { showAuth } from '/shared/auth.js';
import { registerServiceWorker } from '/shared/pwa.js';
import { h, S, api, rawApi, loadNodes, kids, byId, iconOf, goto, toast, createNode, pathOf, menu, offline } from './lib/state.js';
import { pageView } from './views/page.js';
import { journalView } from './views/journal.js';
import { dashboard, searchView, trashView, settingsView, exportView, quickSwitcher, newPage } from './views/more.js';

const root = document.getElementById('app');
registerServiceWorker('/apps/pulsar/sw.js', '/apps/pulsar/');
const brand = { name: 'Pulsar', blurb: 'Your notes, journal and databases.', mark: () => h('div', { class: 'mark', 'aria-hidden': 'true' }, icon('file')) };
S.onUnauthorized = () => { if (S.me) { S.me = null; boot('Your session ended. Sign in again.'); } };

// ---- app lock (device-only screen cover; NOT encryption) ----
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pulsar:${t}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const lock = { has: () => !!localStorage.getItem('pulsar:pin'), off() { localStorage.removeItem('pulsar:pin'); }, async set(p) { localStorage.setItem('pulsar:pin', await sha(p)); } };
function showLock() { return new Promise((res) => { if (!lock.has()) return res(); const err = h('p', { class: 'err' }), pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'PIN' }); const el = h('div', { class: 'lock' }, h('form', { onsubmit: async (e) => { e.preventDefault(); if (await sha(pin.value) === localStorage.getItem('pulsar:pin')) { el.remove(); res(); } else { err.textContent = 'Wrong PIN'; pin.value = ''; } } }, h('h2', { class: 'ni' }, icon('lock', 22), 'Pulsar is locked'), pin, err, h('button', { class: 'btn' }, 'Unlock'))); document.body.append(el); pin.focus(); }); }

function applySettings() {
  const d = document.documentElement, t = S.settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.settings.theme;
  d.dataset.theme = t; d.dataset.width = S.settings.width; d.style.setProperty('--fs', `${S.settings.fontSize}px`); document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#04060f');
  document.querySelectorAll('.ed').forEach((e) => e.setAttribute('spellcheck', String(S.settings.spellcheck)));
}

// ---- shell ----
let cleanup = null, treeSoon, expanded = new Set(JSON.parse(localStorage.getItem('pulsar:open') || '[]'));
const shell = { side: h('aside', { class: 'psb', 'aria-label': 'Navigation' }), crumbs: h('div', { class: 'crumbs' }), actions: h('div', { class: 'row', style: 'gap:0' }), status: h('span', { class: 'status', role: 'status' }), net: h('button', { class: 'netpill', type: 'button', hidden: '', onclick: () => offline.sync() }), main: h('main', { class: 'main-body', style: 'flex:1' }) };
const ctx = {
  main: (el) => { shell.main.replaceChildren(el); applySettings(); window.scrollTo(0, 0); },
  setCrumbs: (cs) => shell.crumbs.replaceChildren(...cs.flatMap((c, i) => [i ? h('span', {}, '/') : null, c.href ? h('a', { href: c.href }, c.label) : h('b', {}, c.label)])),
  setActions: (a) => shell.actions.replaceChildren(...a),
  setStatus: (s, msg) => { shell.status.className = `status ${s === 'error' ? 'err' : s}`; shell.status.textContent = { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes…', error: `Not saved (${msg || 'error'}) — tap to retry`, offline: 'Saved on this device' }[s]; shell.status.onclick = s === 'error' ? () => window.dispatchEvent(new Event('pulsar:retry')) : null; },
  sidebarSoon: () => { clearTimeout(treeSoon); treeSoon = setTimeout(drawSide, 250); }, route: () => route(), applySettings,
};
function drawSide() {
  const cur = (location.hash.match(/^#\/p\/([\w-]+)/) || [])[1]; const open = (id) => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); localStorage.setItem('pulsar:open', JSON.stringify([...expanded])); drawSide(); };
  const row = (n, lv) => { const ch = kids(n.id), isOpen = expanded.has(n.id) || (cur && pathOf(byId(cur) || {}).some((p) => p.id === n.id));
    const r = h('div', { class: `trow${cur === n.id ? ' cur' : ''}`, style: `padding-left:${0.3 + lv * 0.9}rem` }, h('button', { class: `car${isOpen ? ' open' : ''}`, type: 'button', 'aria-label': isOpen ? 'Collapse' : 'Expand', style: ch.length ? '' : 'visibility:hidden', onclick: () => open(n.id) }, icon('chevright', 15)), h('a', { class: 'tt', href: `#/p/${n.id}`, style: 'color:inherit;text-decoration:none;display:flex;gap:.4rem;overflow:hidden;align-items:center', onclick: () => document.body.classList.remove('nav-open') }, h('span', { class: 'ti' }, iconOf(n, 17)), h('span', { class: 'tt' }, n.title || 'Untitled')),
      n.kind !== 'database' ? h('button', { class: 'add', type: 'button', 'aria-label': `Add page inside ${n.title || 'Untitled'}`, title: 'Add a page inside', onclick: async () => { expanded.add(n.id); const p = await createNode({ parentId: n.id }); goto(`#/p/${p.id}`); drawSide(); } }, icon('plus', 15)) : null);
    return [r, ...(isOpen ? ch.map((c) => row(c, lv + 1)).flat() : [])]; };
  const favs = S.nodes.filter((n) => n.favorite && !n.trashedAt), hash = location.hash || '#/'; const nav = (href, label, ic) => h('a', { href, 'aria-current': hash === href || (href !== '#/' && hash.startsWith(href)) ? 'page' : null, onclick: () => document.body.classList.remove('nav-open') }, h('span', {}, ic), label);
  shell.side.replaceChildren(h('a', { class: 'pbrand', href: '#/' }, h('i', {}, icon('file', 16)), 'Pulsar'),
    h('div', { class: 'scroll' }, h('div', { class: 'nav', role: 'navigation', 'aria-label': 'Main' }, h('button', { type: 'button', onclick: () => { document.body.classList.remove('nav-open'); quickSwitcher(); } }, h('span', {}, icon('zap', 17)), 'Quick search', h('small', { style: 'margin-left:auto;color:var(--mute)' }, 'Ctrl K')), nav('#/', 'Home', icon('home', 17)), nav('#/journal', 'Journal', icon('book', 17)), nav('#/search', 'Search', icon('search', 17)), nav('#/export', 'Export & backup', icon('download', 17)), nav('#/trash', 'Trash', icon('trash', 17)), nav('#/settings', 'Settings', icon('settings', 17))),
      favs.length ? [h('div', { class: 'sec' }, 'Favorites'), ...favs.map((n) => h('a', { class: `trow${cur === n.id ? ' cur' : ''}`, href: `#/p/${n.id}`, style: 'text-decoration:none', onclick: () => document.body.classList.remove('nav-open') }, h('span', { class: 'ti' }, iconOf(n, 17)), h('span', { class: 'tt' }, n.title || 'Untitled')))] : null,
      h('div', { class: 'sec' }, 'Workspace', h('span', {}, h('button', { class: 'ib2', style: 'min-width:30px;min-height:30px', type: 'button', 'aria-label': 'New page or collection', onclick: (e) => menu([{ label: 'New page…', run: () => newPage(null) }, { label: 'New collection', run: async () => { const n = await createNode({ kind: 'collection', title: 'Untitled' }); goto(`#/p/${n.id}`); drawSide(); } }, { label: 'New database', run: async () => { const n = await createNode({ kind: 'database', title: 'Untitled' }); goto(`#/p/${n.id}`); drawSide(); } }], e.currentTarget) }, icon('plus', 16)))),
      ...(kids(null).length ? kids(null).flatMap((n) => row(n, 0)) : [h('p', { class: 'sub', style: 'padding:.4rem .6rem' }, 'No pages yet. Use + to create one.')])));
}
window.addEventListener('pulsar:tree', () => drawSide());
function paintNet() {
  const n = offline.pending(), off = !navigator.onLine; shell.net.hidden = !off && !n; shell.net.replaceChildren(icon(off ? 'wifioff' : 'refresh', 15), off ? (n ? `Offline · ${n} to sync` : 'Offline') : `${n} to sync`); shell.net.classList.toggle('off', off);
}
addEventListener('offline', paintNet); addEventListener('pulsar:queue', paintNet);
addEventListener('online', () => { paintNet(); offline.sync(); });
addEventListener('pulsar:sync', (e) => { const d = e.detail; if (d.state === 'end' && (d.sent || d.dropped)) { toast(d.dropped ? `Synced ${d.sent}; ${d.dropped} change(s) could not be saved` : `Synced ${d.sent} offline change${d.sent === 1 ? '' : 's'}`); if (d.sent) loadNodes().then(() => drawSide()).catch(() => {}); } paintNet(); });
setInterval(() => { if (navigator.onLine && offline.pending()) offline.sync(); }, 30000);
window.addEventListener('pulsar:retry', () => route());

function frame() {
  root.replaceChildren(shell.side, h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }), h('div', { class: 'pmain', style: 'flex:1;min-width:0;display:flex;flex-direction:column' }, h('header', { class: 'top' }, h('button', { class: 'ib2 hamb', type: 'button', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu', 20)), shell.crumbs, shell.status, shell.net, shell.actions), shell.main));
}
async function route() {
  if (!S.me || !S.meta) return; if (cleanup) { const c = cleanup; cleanup = null; try { await c(); } catch { /* ignore */ } }
  document.body.classList.remove('nav-open'); ctx.setActions([]); ctx.setStatus('saved'); shell.status.textContent = '';
  const hash = location.hash || '#/'; const [path, q] = hash.slice(1).split('?'); const [, a, b] = path.split('/');
  try {
    if (a === 'p' && b) { if (!S.nodes.length) await loadNodes(); cleanup = await pageView(b, ctx); }
    else if (a === 'journal') await journalView(b, ctx);
    else if (a === 'search') await searchView(q, ctx);
    else if (a === 'trash') await trashView(ctx);
    else if (a === 'settings') settingsView(ctx, { lock, onSignOut: async () => { await offline.forget(); S.me = null; boot(); } });
    else if (a === 'export') await exportView(q, ctx);
    else if (a === 'new') { goto('#/'); newPage(null); }
    else { await loadNodes(); dashboard(ctx); }
  } catch (e) {
    if (e.status === 401) return;
    ctx.setCrumbs([{ label: 'Error' }]); ctx.main(h('div', { class: 'content' }, h('h1', { class: 'pt' }, e.status === 404 ? 'Page not found' : 'Something went wrong'), h('p', { class: 'err', role: 'alert' }, e.status === 404 ? 'This page does not exist or was permanently deleted.' : e.message), h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#/' }, 'Go home'), h('button', { class: 'btn', onclick: route }, 'Try again'))));
  }
  drawSide();
}
async function boot(note = '') {
  try { S.me = await rootApi('GET', '/api/auth/me', undefined, AbortSignal.timeout?.(8000)); offline.rememberMe(S.me); } catch (e) { const c = !e.status && offline.cachedMe(); S.me = c || await showAuth({ root, brand, note }); }
  await offline.init(S.me.user.id, rawApi);
  try { S.meta = await api('GET', '/meta'); } catch (x) { if (x.status === 401) return; root.replaceChildren(h('div', { class: 'content' }, h('h1', {}, 'Pulsar'), h('p', { class: 'sub' }, x.status === 403 || x.status === 404 ? 'Pulsar is not available for your account. Ask an admin to install it and give you access.' : `Pulsar could not load: ${x.message}`), h('button', { class: 'btn ghost', onclick: () => { S.me = null; boot(); } }, 'Sign out'))); return; }
  try { S.settings = { ...S.settings, ...(await api('GET', '/settings')).settings }; } catch { /* defaults */ } applySettings(); await showLock(); frame(); paintNet(); await loadNodes().catch(() => {}); await route(); offline.sync().then(() => offline.prefetch(S.nodes, (id) => api('GET', `/nodes/${id}`)));
}
addEventListener('hashchange', () => route());
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (S.me) quickSwitcher(); } if (e.altKey && e.key.toLowerCase() === 'n' && S.me) { e.preventDefault(); newPage(null); } });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => S.settings.theme === 'system' && applySettings());
boot();
