import '/shared/select.js';
// Nova: Universe's project, task and execution manager. Its own installable app with its own sign-in, navigation and settings.
import { api, h, toast, setUnauthorizedHandler } from './services/api.js';
import { icon } from '/shared/icons.js';
import { api as rootApi, dialog, closer } from '/shared/ui.js';
import { showAuth } from '/shared/auth.js';
import { registerServiceWorker, canPromptInstall, promptInstall, onInstallChange, isStandalone } from '/shared/pwa.js';
import { startNotifier } from '/shared/notify.js';
import { S } from './lib.js';
import { overviewView } from './views/overview.js';
import { tasksView, boardView } from './views/tasks.js';
import { scheduleView } from './views/schedule.js';
import { calendarView } from './views/calendar.js';
import { projectsView, projectView } from './views/projects.js';
import { settingsView } from './views/settings.js';
import { openTask } from './views/taskui.js';

const root = document.getElementById('app');
registerServiceWorker('/apps/nova/sw.js', '/apps/nova/');
const brand = { name: 'Nova', blurb: 'Turn ideas into plans, and plans into finished work.', mark: () => h('div', { class: 'mark nova', 'aria-hidden': 'true' }, icon('target')) };
setUnauthorizedHandler(() => { if (S.me) { S.me = null; boot('Your session ended. Sign in again.'); } });
const signOut = () => { S.me = null; boot(); };

// Phones show five tabs; Schedule, Board and Settings live under More. The sidebar on larger screens shows everything.
const MAIN = ['overview', 'tasks', 'calendar', 'projects'];
const NAV = [['#/', 'Today', 'overview', 'home'], ['#/tasks', 'Tasks', 'tasks', 'check'], ['#/schedule', 'Schedule', 'schedule', 'calendar'], ['#/board', 'Board', 'board', 'columns'], ['#/calendar', 'Calendar', 'calendar', 'calendar'], ['#/projects', 'Projects', 'projects', 'target'], ['#/settings', 'Settings', 'settings', 'settings']];
let lastHash = null, keepY = null;
function frame(page, ...content) {
  const link = ([href, text, id, ic]) => h('a', { href, class: MAIN.includes(id) ? null : 'extra', 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, text));
  const extras = NAV.filter((n) => !MAIN.includes(n[2]));
  const more = h('button', { class: 'morebtn', type: 'button', 'aria-label': 'More', 'aria-current': extras.some((n) => n[2] === page) ? 'page' : null, onclick: () => {
    const d = dialog('More', h('div', { class: 'moremenu' }, extras.map(([href, text, , ic]) => h('a', { href, onclick: () => d.close() }, icon(ic), h('span', {}, text)))), h('div', { class: 'row actions' }, closer())); } }, icon('more'), h('span', {}, 'More'));
  const install = h('button', { class: 'btn ghost small', hidden: '', title: 'Install Nova', 'aria-label': 'Install Nova', onclick: promptInstall }, icon('download'), h('span', { class: 'lbl' }, 'Install'));
  const syncInstall = () => { install.hidden = isStandalone() || !canPromptInstall(); };
  syncInstall(); onInstallChange(syncInstall);
  root.replaceChildren(
    h('header', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Nova overview' }, brand.mark(), h('span', { class: 'brand-text' }, h('b', {}, 'Nova'), h('small', {}, 'Hie Technologies'))),
      h('nav', { 'aria-label': 'Main' }, NAV.map(link), more),
      h('div', { class: 'me' }, h('span', { class: 'who' }, S.me.user.displayName), install,
        h('button', { class: 'btn ghost small', 'aria-label': 'Sign out', title: 'Sign out', onclick: async () => { try { await rootApi('POST', '/api/auth/logout'); } catch { /* already signed out */ } signOut(); } }, icon('logout'), h('span', { class: 'lbl' }, 'Sign out')))),
    h('main', { class: 'main' }, h('div', { class: 'wrap' }, ...content)),
    S.meta?.canWriteTasks ? h('button', { class: 'fab', type: 'button', 'aria-label': 'New task', title: 'New task (n)', onclick: () => openTask(null, { onChange: route }) }, icon('plus')) : null);
  window.scrollTo(0, keepY ?? 0); keepY = null;
}

const go = (hash) => { location.hash = hash; };
async function route() {
  if (!S.me || !S.meta) return;
  const hash = location.hash || '#/', same = hash === lastHash; lastHash = hash; keepY = same ? window.scrollY : null;
  const [, page = '', arg] = hash.split('/');
  const ctx = { frame, redraw: route, go, onSignOut: signOut };
  try {
    S.projects = (await api('GET', '/projects')).projects;
    if (page === 'tasks') await tasksView(ctx);
    else if (page === 'board') await boardView(ctx);
    else if (page === 'schedule') await scheduleView(ctx);
    else if (page === 'calendar') await calendarView(ctx);
    else if (page === 'projects') await projectsView(ctx);
    else if (page === 'project' && arg) await projectView(arg, ctx);
    else if (page === 'settings') settingsView(ctx);
    else if (page === 'new') { go('#/'); openTask(null, { onChange: route }); }
    else await overviewView(ctx);
  } catch (x) {
    if (x.status === 401) return;
    frame('overview', h('h1', {}, 'Nova'), h('p', { class: 'err', role: 'alert' }, `Something went wrong: ${x.message}`), h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: route }, 'Try again')));
  }
}

async function boot(note = '') {
  try { S.me = await rootApi('GET', '/api/auth/me'); }
  catch { S.me = await showAuth({ root, brand, note }); }
  try { S.meta = await api('GET', '/meta'); }
  catch (x) {
    if (x.status === 401) return;
    frame('overview', h('h1', {}, 'Nova'), h('p', { class: 'muted' }, x.status === 403 ? 'Your account does not have access to Nova yet. Ask an admin to give you access.' : `Nova could not load: ${x.message}`),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')));
    return;
  }
  // First visit: remember this device's time zone so "today" and "overdue" are right.
  if (!S.meta.settings.configured && S.meta.canWriteTasks) {
    try { S.meta.settings = (await api('PUT', '/settings', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })).settings; } catch { /* stays UTC until set in Settings */ }
  }
  await route(); startNotifier(['/api/apps/nova/notifications']);
}
addEventListener('hashchange', () => S.me && S.meta && route());
addEventListener('keydown', (e) => { // "n" opens a new task, unless you are typing
  const el = document.activeElement;
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && S.meta?.canWriteTasks && !document.querySelector('dialog[open]') && !(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el?.isContentEditable)) { e.preventDefault(); openTask(null, { onChange: route }); }
});
boot();
