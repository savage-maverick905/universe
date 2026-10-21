// Notifications from your apps. A page asks each app "anything worth a nudge?" once a minute while it is open
// and shows new items through the service worker, so they appear like any other phone notification.
// Each item has a stable id, remembered on this device, so you only get it once.
import { h } from '/shared/ui.js';
const KEY = 'universe.notify', SEEN = 'universe.notify.seen';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
export const supported = () => 'Notification' in window && 'serviceWorker' in navigator;
export const enabled = () => supported() && Notification.permission === 'granted' && store.get(KEY) !== 'off';
export async function enable() { if (!supported()) return 'unsupported'; const p = await Notification.requestPermission(); if (p === 'granted') store.set(KEY, 'on'); return p; }
export const disable = () => store.set(KEY, 'off');
const seenIds = () => { try { return new Set(JSON.parse(store.get(SEEN) || '[]')); } catch { return new Set(); } };
async function show(item, { force = false } = {}) {
  const seen = seenIds(); if (!force && seen.has(item.id)) return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(item.title, { body: item.body || '', tag: item.id, icon: item.icon || '/dashboard/icons/icon-192.png', badge: item.icon || '/dashboard/icons/icon-192.png', data: { url: item.url || '/dashboard/' } });
  seen.add(item.id); store.set(SEEN, JSON.stringify([...seen].slice(-300)));
}
let timer = null;
export function startNotifier(urls, { every = 60_000 } = {}) {
  clearInterval(timer);
  const poll = async () => { if (!enabled()) return;
    for (const url of urls) { try { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) continue; for (const it of (await r.json()).items || []) await show(it); } catch { /* offline: try again next time */ } } };
  poll(); timer = setInterval(poll, every); document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
// A settings card: turn notifications on or off, and send yourself a test.
export function notifyCard() {
  const msg = h('p', { class: 'fine' }), btn = h('button', { class: 'btn small', type: 'button' }), test = h('button', { class: 'btn ghost small', type: 'button', onclick: () => show({ id: `test:${Date.now()}`, title: 'Notifications are working', body: 'You will get nudges about events, tasks, budgets and due dates.', url: location.pathname }, { force: true }).catch(() => { msg.textContent = 'Could not show a notification on this device.'; }) }, 'Send a test');
  const draw = () => {
    if (!supported()) { msg.textContent = 'This browser does not support notifications. On iPhone, add the app to your Home Screen first (iOS 16.4 or newer).'; btn.hidden = test.hidden = true; return; }
    if (Notification.permission === 'denied') { msg.textContent = 'Notifications are blocked for this site. Allow them in your browser or phone settings, then come back.'; btn.hidden = test.hidden = true; return; }
    const on = enabled(); btn.hidden = false; test.hidden = !on; btn.textContent = on ? 'Turn off' : 'Turn on notifications';
    msg.textContent = on ? 'On. Nudges arrive while an app is open or running in the background. Nothing is sent to anyone else.' : 'Get nudges for events about to start, tasks due today, budgets running out and money due.';
  };
  btn.onclick = async () => { if (enabled()) disable(); else await enable(); draw(); };
  draw(); return h('section', { class: 'card' }, h('h3', {}, 'Notifications'), msg, h('div', { class: 'row' }, btn, test));
}
