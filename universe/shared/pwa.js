// Installable-app helpers shared by the dashboard and every app.
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
addEventListener('appinstalled', () => { deferred = null; notify(); });

export function registerServiceWorker(url, scope) {
  if (!('serviceWorker' in navigator)) return;
  addEventListener('load', () => { navigator.serviceWorker.register(url, { scope }).catch(() => { /* the app still works without it */ }); });
}
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canPromptInstall = () => deferred !== null;
export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null; notify();
  return outcome === 'accepted';
}
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
