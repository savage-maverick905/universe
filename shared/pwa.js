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

// ---- Phone behaviour: no pinch zoom, and a keyboard-aware viewport ----
// iOS ignores user-scalable=no, so pinch gestures are blocked here too.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// Publishes the visible height as --vvh and adds .kb-open to <html> while the on-screen keyboard is up,
// so the bottom tab bar steps out of the way instead of riding up above the keyboard.
{
  const vv = window.visualViewport, rootEl = document.documentElement;
  let base = window.innerHeight;
  const editing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color|image|reset)$/.test(a.type)));
  };
  const sync = () => {
    const vh = vv ? vv.height : window.innerHeight;
    if (!editing()) base = Math.max(window.innerHeight, vh);
    rootEl.style.setProperty('--vvh', `${Math.round(vh)}px`);
    const open = editing() && base - vh > 120;
    rootEl.classList.toggle('kb-open', open);
    if (open && document.body?.dataset.page === 'assistant') window.scrollTo(0, 0); // iOS scrolls the page to the field
  };
  vv?.addEventListener('resize', sync); vv?.addEventListener('scroll', sync);
  addEventListener('resize', sync); addEventListener('orientationchange', () => setTimeout(sync, 200));
  addEventListener('focusin', sync); addEventListener('focusout', () => setTimeout(sync, 60));
  sync();
}
