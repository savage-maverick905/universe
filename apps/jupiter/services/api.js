// Jupiter's API client. Paths are relative to /api/apps/jupiter.
import { h, toast, api as call, dialog, closer } from '/shared/ui.js';
export { h, toast, dialog, closer };
export const B = '/api/apps/jupiter';
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Reads are retried on a flaky connection (network failure, timeout, 502/503/504) with a short backoff; writes are never repeated automatically.
export async function api(method, path, body) {
  const tries = method === 'GET' ? 3 : 1;
  for (let a = 1; ; a++) {
    try { return await withTimeout((signal) => call(method, B + path, body, signal), method === 'GET' ? 20000 : 60000); }
    catch (e) {
      if (e.status === 401) onUnauthorized();
      const flaky = !e.status || [502, 503, 504].includes(e.status);
      if (!flaky || a >= tries) throw (!e.status ? Object.assign(new Error('The connection is weak or down. Check your network and try again.'), { network: true }) : e);
      await sleep(700 * a);
    }
  }
}
function withTimeout(fn, ms) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); return fn(c.signal).finally(() => clearTimeout(t)); }
// Raw bytes (upload pieces, artwork). Same CSRF header as every other write.
export async function sendBytes(path, bytes, headers = {}) {
  const res = await fetch(B + path, { method: 'PUT', headers: { 'X-Requested-With': 'universe', 'Content-Type': 'application/octet-stream', ...headers }, body: bytes });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || 'Upload failed'), { status: res.status, code: json?.error?.code });
  return json;
}
if (typeof Element !== 'undefined' && !Element.prototype.__flatKids) {
  for (const m of ['replaceChildren', 'append', 'prepend']) { const n = Element.prototype[m]; Element.prototype[m] = function (...k) { return n.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); }; }
  Element.prototype.__flatKids = true;
}
export const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const fmtHours = (ms) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
export const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
