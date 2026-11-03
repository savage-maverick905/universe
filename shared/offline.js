// "You're offline" for every app. The app's screens, menus and navigation stay put (they are kept on the device by the
// service worker); only the part that needs the server shows this notice, and it fills itself in again when the connection returns.
import { h } from './ui.js';
import { icon } from './icons.js';

const META = 'universe.meta.';
export const cachedMeta = (app) => { try { return JSON.parse(localStorage.getItem(META + app)); } catch { return null; } };
export const rememberMeta = (app, meta) => { try { localStorage.setItem(META + app, JSON.stringify(meta)); } catch { /* storage may be blocked */ } };

// The notice itself. `retry` runs when the person taps Try again, and once automatically when the device comes back online.
export function offlinePanel({ app = 'This app', retry, text = '' } = {}) {
  const go = () => { removeEventListener('online', go); retry?.(); };
  addEventListener('online', go);
  return h('div', { class: 'uni-offline', role: 'status' }, h('span', { class: 'uni-offline-ico' }, icon('wifioff')), h('h2', {}, "You're offline"),
    h('p', {}, text || `${app} can't reach the server right now. You can keep moving around; this page fills in as soon as you're back online.`),
    retry ? h('button', { class: 'btn', type: 'button', onclick: go }, icon('refresh'), 'Try again') : null);
}

// Full-page version for when an app opens offline with nothing remembered on this device yet (the very first launch).
export function showOfflineScreen({ root, brand, retry }) {
  root.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'auth-brand' }, brand.mark(), h('div', {}, h('h1', {}, brand.name), h('p', { class: 'muted' }, brand.blurb))),
    offlinePanel({ app: brand.name, retry, text: `${brand.name} needs a connection the first time you open it on this device. It will continue by itself once you're online.` })));
}
