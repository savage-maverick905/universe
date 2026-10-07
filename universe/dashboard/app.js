// Dashboard shell. Built with textContent only (never innerHTML) so API data cannot inject markup.
import { assistantView } from './assistant.js';
import { reportsView } from './reports.js';
import { icon, hasIcon } from '/shared/icons.js';

const root = document.getElementById('root');
let me = null;

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'X-Requested-With': 'universe', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { status: res.status });
  return json;
}
function toast(msg) { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }

function loginView(note = '') {
  const err = h('p', { class: 'err', role: 'alert' }, note);
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('POST', '/api/auth/login', { email: email.value, password: pw.value }); await boot(); }
    catch (x) { err.textContent = x.message; }
  } }, email, pw, err, h('button', { class: 'btn' }, 'Sign in'));
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'mark', 'aria-hidden': 'true' }, 'U'), h('h1', {}, 'Sign in to Universe'), h('p', { class: 'muted' }, 'Your apps and assistant, in one place.'), form));
}

const NAV = [['#/', 'Home', 'home', 'home'], ['#/assistant', 'Assistant', 'assistant', 'message'], ['#/reports', 'Reports', 'reports', 'file'], ['#/apps', 'Apps', 'apps', 'grid']];
function shell(page, content) {
  const link = ([href, label, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, label));
  root.replaceChildren(
    h('header', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Universe home' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, 'U'),
        h('span', { class: 'brand-text' }, h('b', {}, 'Universe'), h('small', {}, 'Hie Technologies'))),
      h('nav', { 'aria-label': 'Main' }, NAV.map(link)),
      h('div', { class: 'me' }, h('span', { class: 'who' }, me.user.displayName),
        h('button', { class: 'btn ghost small', 'aria-label': 'Sign out', title: 'Sign out', onclick: async () => { await api('POST', '/api/auth/logout'); me = null; loginView(); } }, icon('logout'), h('span', { class: 'lbl' }, 'Sign out')))),
    h('main', { class: 'main' }, h('div', { class: 'wrap' }, content)));
  window.scrollTo(0, 0);
}

// ---- widgets: contract per type (the app's dataEndpoint must return this shape) ----
//  stat  -> { stats: [{label, value}] }   list -> { items: [{title, subtitle?}] }   chart -> { series: [{label, value}] }
function renderWidget(w, data) {
  if (w.type === 'stat') return h('div', { class: 'stats' }, (data.stats || []).map((s) => h('div', { class: 'stat' }, h('b', {}, String(s.value)), h('span', {}, s.label))));
  if (w.type === 'list') return h('ul', { class: 'items' }, (data.items || []).map((i) => h('li', {}, i.title, i.subtitle ? h('div', { class: 'sub' }, i.subtitle) : null)));
  const max = Math.max(1, ...(data.series || []).map((s) => s.value));
  return h('div', {}, (data.series || []).map((s) => h('div', { class: 'bar' }, h('span', {}, s.label), h('span', { class: 'track' }, h('i', { style: `width:${Math.round((s.value / max) * 100)}%` })), h('span', {}, String(s.value)))));
}
function widgetCard(w) {
  const body = h('p', { class: 'muted' }, 'Loading…');
  api('GET', w.dataEndpoint).then((d) => body.replaceWith(renderWidget(w, d)))
    .catch(() => { body.textContent = 'No data yet. This app has not provided data for this widget.'; });
  return h('article', { class: 'card' }, h('h3', {}, w.title), h('div', { class: 'sub' }, w.appName), body);
}

async function homeView() {
  const { widgets } = await api('GET', '/api/dashboard/widgets');
  let aiName = null;
  if (me.permissions.includes('ai.use')) { try { aiName = (await api('GET', '/api/ai/profile')).profile.name; } catch { /* assistant optional */ } }
  const hero = h('section', { class: 'hello' },
    h('div', {}, h('h1', {}, `Hello, ${me.user.displayName}`),
      h('p', { class: 'muted' }, aiName ? `${aiName} can look things up in your apps for you.` : 'The assistant is not enabled for your account.')),
    aiName ? h('a', { class: 'btn', href: '#/assistant' }, icon('message'), `Talk to ${aiName}`) : null);
  const body = widgets.length
    ? h('div', { class: 'grid' }, widgets.map(widgetCard))
    : h('div', { class: 'card' }, h('p', {}, 'No widgets yet. Install an app and its widgets appear here.'), h('a', { class: 'btn small', href: '#/apps' }, icon('grid'), 'Browse apps'));
  shell('home', [hero, h('section', {}, h('h2', {}, 'Overview'), body)]);
}

async function appsView() {
  const { apps } = await api('GET', '/api/apps');
  const admin = me.permissions.includes('apps.manage');
  const act = (id, action, msg) => async () => {
    try { await api('POST', `/api/apps/${id}/${action}`); toast(msg); await route(); } catch (x) { toast(x.message); }
  };
  const card = (a) => {
    const buttons = [];
    if (a.status === 'available') buttons.push(admin ? h('button', { class: 'btn small', onclick: act(a.id, 'install', `${a.name} installed`) }, 'Install') : h('span', { class: 'muted' }, 'Ask an admin to install'));
    else {
      if (a.status === 'enabled') buttons.push(h('a', { class: 'btn small', href: a.openUrl }, 'Open'));
      if (admin) buttons.push(a.status === 'enabled'
        ? h('button', { class: 'btn ghost small', onclick: act(a.id, 'disable', `${a.name} disabled`) }, 'Disable')
        : h('button', { class: 'btn ghost small', onclick: act(a.id, 'enable', `${a.name} enabled`) }, 'Enable'),
        h('button', { class: 'btn ghost small danger', onclick: act(a.id, 'uninstall', `${a.name} uninstalled`) }, 'Uninstall'));
    }
    const badge = a.status === 'available' ? null : h('span', { class: a.status === 'enabled' ? 'badge' : 'badge off' }, a.status === 'enabled' ? 'Installed' : 'Disabled');
    return h('article', { class: 'card app' }, h('div', { class: 'ico', 'aria-hidden': 'true' }, hasIcon(a.icon) ? icon(a.icon) : a.name[0]),
      h('div', {}, h('div', { class: 'app-head' }, h('h3', {}, a.name), badge), h('div', { class: 'sub' }, `${a.description} Version ${a.version}.`), h('div', { class: 'row' }, buttons)));
  };
  const installed = apps.filter((a) => a.installed), available = apps.filter((a) => !a.installed);
  const group = (title, list, empty) => h('section', {}, h('h2', {}, title), list.length ? h('div', { class: 'grid' }, list.map(card)) : h('p', { class: 'muted' }, empty));
  shell('apps', [h('h1', {}, 'Apps'), group('Installed', installed, 'Nothing installed yet.'), group('Available', available, 'Every available app is installed.')]);
}

async function route() {
  try { if (location.hash === '#/apps') await appsView(); else if (location.hash === '#/reports') await reportsView({ h, api, toast, shell });
    else if (location.hash === '#/assistant') await assistantView({ h, api, toast, shell, me }); else await homeView(); }
  catch (x) { if (x.status === 401) { me = null; loginView('Your session ended. Sign in again.'); } else toast(x.message); }
}
async function boot() {
  try { me = await api('GET', '/api/auth/me'); await route(); } catch { loginView(); }
}
addEventListener('hashchange', () => me && route());
boot();
