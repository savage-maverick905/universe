// Orbit's API client. The server decides what is locked: a 423 here means "show the PIN screen", whatever the screen was doing.
import { api as call, h, toast } from '/shared/ui.js';
export { h, toast };
export const B = '/api/apps/finance';
const hooks = { locked: () => {}, signedOut: () => {} };
export const setHooks = (x) => Object.assign(hooks, x);
// Smoother navigation: GET answers are kept in memory for this tab only (never written to disk), shown instantly when you
// come back to a screen, and refreshed in the background. Any write, lock or sign-out clears them, so numbers never go stale after a change.
const mem = new Map(), TTL = 30_000;
export const clearCache = () => mem.clear();
export async function api(method, path, body) {
  if (method === 'GET') {
    const hit = mem.get(path);
    if (hit && Date.now() - hit.at < TTL) return structuredClone(hit.data);
    if (hit?.pending) return hit.pending.then((d) => structuredClone(d));
    const pending = real('GET', path).then((d) => { mem.set(path, { at: Date.now(), data: d }); return d; }, (e) => { mem.delete(path); throw e; });
    mem.set(path, { at: 0, pending, data: null });
    return pending.then((d) => structuredClone(d));
  }
  mem.clear();
  return real(method, path, body);
}
async function real(method, path, body) {
  try { return await call(method, B + path, body); }
  catch (e) {
    if (e.status === 401 && e.code === 'unauthenticated') { mem.clear(); hooks.signedOut(); }
    if (e.status === 423) { mem.clear(); hooks.locked(e); }
    throw e;
  }
}
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);
// Used on page hide: fire-and-forget lock that survives the page going away. Needs the same CSRF header as every other write.
export function lockNow() { try { fetch(`${B}/lock`, { method: 'POST', keepalive: true, headers: { 'X-Requested-With': 'universe' } }); } catch { /* the server's idle timeout still locks it */ } }
