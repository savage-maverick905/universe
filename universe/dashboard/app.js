// Dashboard shell. Built with textContent only (never innerHTML) so API data cannot inject markup.
import { assistantView } from './assistant.js';
import { reportsView } from './reports.js';
import { icon, hasIcon } from '/shared/icons.js';

import { settingsView } from './settings.js';
import { h, api as rawApi, toast } from '/shared/ui.js';
import { showAuth } from '/shared/auth.js';
import { renderWidget } from '/shared/widgets.js';
import { registerServiceWorker, canPromptInstall, promptInstall, onInstallChange, isStandalone } from '/shared/pwa.js';

const root = document.getElementById('root');
let me = null;
const api = rawApi;

// The dashboard lives at /dashboard/ so it is its own installable app, separate from the apps it opens.
if (location.pathname === '/') history.replaceState(null, '', `/dashboard/${location.search}${location.hash}`);
registerServiceWorker('/dashboard/sw.js', '/dashboard/');

const brand = { name: 'Universe', blurb: 'Your apps and assistant, in one place.', mark: () => h('div', { class: 'mark', 'aria-hidden': 'true' }, 'U') };
const signOut = () => { me = null; boot(); };

function shell(page, content) {
  const nav = [['#/', 'Home', 'home', 'home'], me.permissions.includes('ai.use') ? ['#/assistant', 'Assistant', 'assistant', 'message'] : null,
    ['#/reports', 'Reports', 'reports', 'file'], ['#/apps', 'Apps', 'apps', 'grid'], ['#/settings', 'Settings', 'settings', 'settings']].filter(Boolean);
  const link = ([href, label, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, label));
  const install = h('button', { class: 'btn ghost small', hidden: '', title: 'Install Universe', 'aria-label': 'Install Universe', onclick: promptInstall }, icon('download'), h('span', { class: 'lbl' }, 'Install'));
  const syncInstall = () => { install.hidden = isStandalone() || !canPromptInstall(); };
  syncInstall(); onInstallChange(syncInstall);
  root.replaceChildren(
    h('header', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Universe home' }, brand.mark(),
        h('span', { class: 'brand-text' }, h('b', {}, 'Universe'), h('small', {}, 'Hie Technologies'))),
      h('nav', { 'aria-label': 'Main' }, nav.map(link)),
      h('div', { class: 'me' }, h('span', { class: 'who' }, me.user.displayName), install,
        h('button', { class: 'btn ghost small', 'aria-label': 'Sign out', title: 'Sign out', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch { /* already out */ } signOut(); } }, icon('logout'), h('span', { class: 'lbl' }, 'Sign out')))),
    h('main', { class: 'main' }, h('div', { class: 'wrap' }, content)));
  document.body.dataset.page = page; window.scrollTo(0, 0);
}

function widgetCard(w) {
  const body = h('p', { class: 'muted' }, 'Loading…');
  api('GET', w.dataEndpoint).then((d) => body.replaceWith(renderWidget(w.type, d)))
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
      if (a.status === 'enabled') buttons.push(h('a', { class: 'btn small', href: a.openUrl, target: '_blank', rel: 'noopener' }, 'Open')); // apps are separate installable apps
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
  try {
    const hash = location.hash;
    if (hash === '#/apps') await appsView();
    else if (hash === '#/reports') await reportsView({ h, api, toast, shell });
    else if (hash === '#/assistant') await assistantView({ h, api, toast, shell, me });
    else if (hash === '#/settings') await settingsView({ me, shell, onSignOut: signOut });
    else await homeView();
  } catch (x) { if (x.status === 401) { me = null; boot('Your session ended. Sign in again.'); } else toast(x.message); }
}
async function boot(note = '') {
  try { me = await api('GET', '/api/auth/me'); }
  catch { me = await showAuth({ root, brand, note }); }
  await route();
}
addEventListener('hashchange', () => me && route());
boot();
