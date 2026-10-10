// Orbit's API client. The server decides what is locked: a 423 here means "show the PIN screen", whatever the screen was doing.
import { api as call, h, toast } from '/shared/ui.js';
export { h, toast };
export const B = '/api/apps/finance';
const hooks = { locked: () => {}, signedOut: () => {} };
export const setHooks = (x) => Object.assign(hooks, x);
export async function api(method, path, body) {
  try { return await call(method, B + path, body); }
  catch (e) {
    if (e.status === 401 && e.code === 'unauthenticated') hooks.signedOut();
    if (e.status === 423) hooks.locked(e);
    throw e;
  }
}
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);
// Used on page hide: fire-and-forget lock that survives the page going away. Needs the same CSRF header as every other write.
export function lockNow() { try { fetch(`${B}/lock`, { method: 'POST', keepalive: true, headers: { 'X-Requested-With': 'universe' } }); } catch { /* the server's idle timeout still locks it */ } }
