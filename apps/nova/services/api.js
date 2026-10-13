// Nova's own API client. Paths are relative to /api/apps/nova.
import { h, toast, api as call } from '/shared/ui.js';
export { h, toast };
export const B = '/api/apps/nova';
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export async function api(method, path, body) {
  try { return await call(method, B + path, body); }
  catch (e) { if (e.status === 401) onUnauthorized(); throw e; }
}
