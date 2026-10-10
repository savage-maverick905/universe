// Orbit — by Universe. Shell, routing, and the lock lifecycle.
import { api, h, toast, setHooks, lockNow } from './lib/api.js';
import { S, loadBase } from './lib/forms.js';
import { setCurrencies } from './lib/fmt.js';
import { lockScreen } from './views/lock.js';
import { icon } from '/shared/icons.js';
import { showAuth } from '/shared/auth.js';
import { api as rootApi } from '/shared/ui.js';
import { registerServiceWorker, canPromptInstall, promptInstall, onInstallChange, isStandalone } from '/shared/pwa.js';

const root = document.getElementById('app');
registerServiceWorker('/apps/finance/sw.js', '/apps/finance/');
const brand = { name: 'Orbit', blurb: 'by Universe. Your money, in orbit.', mark: () => h('div', { class: 'mark orbit', 'aria-hidden': 'true' }, icon('wallet')) };

const state = { me: null, unlocked: false, session: null, hiddenAt: 0 };
const NAV = [['#/', 'Home', 'home', 'home'], ['#/activity', 'Activity', 'activity', 'swap'], ['#/assistant', 'Assistant', 'assistant', 'sparkle'], ['#/plan', 'Plan', 'plan', 'target'], ['#/more', 'More', 'more', 'more']];
const ROUTES = {}; // filled lazily so a locked app never even downloads the finance screens
const load = { home: () => import('./views/home.js'), activity: () => import('./views/activity.js'), assistant: () => import('./views/assistant.js'), plan: () => import('./views/plan.js'),
  more: () => import('./views/settings.js'), accounts: () => import('./views/accounts.js'), categories: () => import('./views/categories.js'), reports: () => import('./views/reports.js'), settings: () => import('./views/settings.js') };

export function frame(page, ...content) {
  const link = ([href, label, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, label));
  const install = h('button', { class: 'btn ghost small', hidden: '', title: 'Install Orbit', 'aria-label': 'Install Orbit', onclick: promptInstall }, icon('download'), h('span', { class: 'lbl' }, 'Install'));
  const sync = () => { install.hidden = isStandalone() || !canPromptInstall(); }; sync(); onInstallChange(sync);
  const offline = h('div', { class: 'offline', role: 'status', hidden: navigator.onLine ? '' : null }, 'You are offline. Orbit needs a connection to show or save anything, so nothing is stored on this device.');
  addEventListener('online', () => { offline.hidden = true; }); addEventListener('offline', () => { offline.hidden = false; });
  root.replaceChildren(
    h('header', { class: 'side' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Orbit home' }, brand.mark(), h('span', { class: 'brand-text' }, h('b', {}, 'Orbit'), h('small', {}, 'by Universe'))),
      h('nav', { 'aria-label': 'Main' }, NAV.map(link)),
      h('div', { class: 'me' }, h('span', { class: 'who' }, state.me.user.displayName), install,
        h('button', { class: 'btn ghost small', 'aria-label': 'Lock Orbit', title: 'Lock Orbit', onclick: lock }, icon('lock'), h('span', { class: 'lbl' }, 'Lock')))),
    h('main', { class: 'main' }, offline, h('div', { class: 'wrap' }, ...content)));
  window.scrollTo(0, 0);
}
export const goto = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

async function lock() { try { await api('POST', '/lock'); } catch { /* already locked */ } showLock('unlock'); }
function showLock(mode, notice = '') {
  state.unlocked = false; S.accounts = []; S.cats = []; S.settings = null; // drop everything held in memory
  root.replaceChildren(); document.title = 'Orbit — by Universe';
  lockScreen(root, { mode, notice, onUnlocked: start, onSignOut: async () => { try { await rootApi('POST', '/api/auth/logout'); } catch { /* ignore */ } state.me = null; boot(); } });
}

async function route() {
  if (!state.unlocked) return;
  const [path, ...rest] = (location.hash || '#/').replace(/^#\/?/, '').split('/'), page = path || 'home';
  const key = ({ '': 'home', home: 'home', activity: 'activity', assistant: 'assistant', plan: 'plan', more: 'more', accounts: 'accounts', categories: 'categories', reports: 'reports', settings: 'settings', add: 'activity' })[page] || 'home';
  try {
    const mod = await load[key]();
    if (page === 'add') { history.replaceState(null, '', '#/activity'); await mod.render({ frame, goto, state, rest: [], openAdd: true }); return; }
    await mod.render({ frame, goto, state, rest, page });
  } catch (e) { if (e.status === 423) return; frame(key, h('div', { class: 'card' }, h('h3', {}, 'Something went wrong'), h('p', { class: 'err' }, e.message), h('button', { class: 'btn small', onclick: route }, 'Try again'))); }
}
addEventListener('hashchange', route);

// ----- lock on return: when the page is hidden, blur it; if it stays hidden past the user's limit, lock for real -----
document.addEventListener('visibilitychange', () => {
  if (!state.unlocked) return;
  if (document.hidden) { state.hiddenAt = Date.now(); document.body.classList.add('hidden-now'); if ((state.session?.lockWhenHiddenSec ?? 0) === 0) lockNow(); }
  else {
    document.body.classList.remove('hidden-now');
    const away = (Date.now() - state.hiddenAt) / 1000;
    if (state.hiddenAt && away >= (state.session?.lockWhenHiddenSec ?? 0)) { lockNow(); showLock('unlock', 'Locked while you were away.'); }
    state.hiddenAt = 0;
  }
});
// client-side idle timer is only a convenience for the screen; the server enforces the real timeout on every request
let idleTimer = null;
function armIdle() { clearTimeout(idleTimer); const m = state.session?.idleMinutes ?? 5; idleTimer = setTimeout(() => { if (state.unlocked) { lockNow(); showLock('unlock', 'Locked after a period of inactivity.'); } }, m * 60_000); }
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { if (state.unlocked) armIdle(); }, { passive: true });

setHooks({ locked: () => { if (state.unlocked) showLock('unlock', 'Orbit locked. Enter your PIN to continue.'); }, signedOut: () => { state.me = null; state.unlocked = false; boot('Your session ended. Sign in again.'); } });

async function start() {
  const sess = await api('GET', '/session'); state.session = sess;
  if (!sess.configured) return showLock('unavailable');
  if (!sess.hasPin) return showLock('setup');
  if (!sess.unlocked) return showLock('unlock');
  try { await loadBase(); } catch (e) { if (e.status === 423) return showLock('unlock'); throw e; }
  setCurrencies([...(S.meta.currencies || [])]); state.unlocked = true; armIdle();
  if (!location.hash) location.hash = '#/'; else route();
}
async function boot(note = '') {
  try { const me = await rootApi('GET', '/api/auth/me'); state.me = me; } catch { state.me = null; }
  if (!state.me) { state.me = await showAuth({ root, brand, note }); }
  document.title = 'Orbit — by Universe';
  try { await start(); } catch (e) { root.replaceChildren(h('main', { class: 'auth' }, h('h1', {}, 'Orbit'), h('p', { class: 'err' }, e.status === 403 ? 'Your account does not have access to Orbit. Ask an admin to grant the finance permissions.' : e.status === 404 ? 'Orbit is not installed. An admin can install it from the Universe dashboard.' : e.message))); }
}
boot();
