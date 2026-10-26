// Offline downloads: tracks the PERSON chooses are saved in IndexedDB (not the page cache). A track counts as "available offline" only when
// every byte is saved and the total matches the size the server reported. Browsers may clear this storage under pressure or after long
// non-use (iOS Safari for sites not added to the Home Screen); the app re-checks on every start and says so honestly.
const DB = 'jupiter-offline';
let dbp;
const STORES = [['meta', { keyPath: 'id' }], ['parts', undefined]];
const openOnce = (v) => new Promise((res, rej) => { const r = indexedDB.open(DB, v); r.onupgradeneeded = () => { for (const [n, o] of STORES) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, o); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
// Version 2 creates any store an older build left out ("One of the specified object stores was not found"). If it is still wrong, the database is rebuilt.
const open = () => (dbp ||= (async () => {
  let db = await openOnce(2);
  if (!STORES.every(([n]) => db.objectStoreNames.contains(n))) { db.close(); await new Promise((res) => { const d = indexedDB.deleteDatabase(DB); d.onsuccess = d.onerror = d.onblocked = () => res(); }); db = await openOnce(2); }
  db.onversionchange = () => { db.close(); dbp = null; };
  return db;
})().catch((e) => { dbp = null; throw e; }));
const tx = async (stores, mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(stores, mode); let out; Promise.resolve(fn(...[].concat(stores).map((s) => t.objectStore(s)))).then((v) => { out = v; }).catch(rej); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const supported = () => typeof indexedDB !== 'undefined';
export async function list() { try { return await tx('meta', 'readonly', (m) => rq(m.getAll())); } catch { return []; } }
export async function completeIds() { return new Set((await list()).filter((m) => m.done).map((m) => m.id)); }
export async function usage() { const all = await list(); const est = await navigator.storage?.estimate?.().catch(() => null); return { bytes: all.filter((m) => m.done).reduce((n, m) => n + m.size, 0), quota: est?.quota || null, usage: est?.usage || null, persisted: await navigator.storage?.persisted?.().catch(() => false) }; }
export async function remove(id) { const m = await tx('meta', 'readonly', (s) => rq(s.get(id))); await tx(['meta', 'parts'], 'readwrite', (meta, parts) => { meta.delete(id); for (let i = 0; i < (m?.partCount || 200); i++) parts.delete(`${id}:${i}`); }); }
export async function download(track, { base, partSize, onProgress, signal, artUrl }) {
  navigator.storage?.persist?.().catch(() => {});
  const partCount = Math.ceil(track.size / partSize); let got = 0;
  await tx('meta', 'readwrite', (m) => m.put({ id: track.id, track, size: track.size, partCount, done: false, at: Date.now() }));
  try {
    for (let i = 0; i < partCount; i++) {
      const start = i * partSize, end = Math.min(track.size, start + partSize) - 1;
      const res = await fetch(`${base}/tracks/${track.id}/audio`, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (res.status === 404) throw Object.assign(new Error('This track\'s audio is missing from storage.'), { missing: true });
      if (res.status !== 206 && res.status !== 200) throw new Error(`The server answered ${res.status}`);
      const blob = await res.blob(); if (blob.size !== end - start + 1) throw new Error('A piece arrived incomplete');
      await tx('parts', 'readwrite', (p) => p.put(blob, `${track.id}:${i}`)); got += blob.size; onProgress?.(got / track.size);
    }
    let art = null; if (artUrl) { try { const r = await fetch(artUrl); if (r.ok) art = await r.blob(); } catch { /* artwork is optional */ } }
    if (got !== track.size) throw new Error('The saved size does not match the track');
    await tx('meta', 'readwrite', (m) => m.put({ id: track.id, track, size: track.size, partCount, done: true, art, mime: track.mime || mimeOf(track.kind), at: Date.now() }));
  } catch (e) { await remove(track.id).catch(() => {}); throw e.name === 'QuotaExceededError' ? Object.assign(new Error('This device is out of storage for downloads. Remove some downloads and try again.'), { quota: true }) : e; }
}
const mimeOf = (k) => ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav' }[k] || 'audio/mpeg');
// Returns an object URL for a fully downloaded track, or null if anything is missing (then it is no longer "offline").
export async function blobUrl(id) {
  const m = await tx('meta', 'readonly', (s) => rq(s.get(id))); if (!m?.done) return null;
  const parts = []; for (let i = 0; i < m.partCount; i++) { const b = await tx('parts', 'readonly', (p) => rq(p.get(`${id}:${i}`))); if (!b) { await remove(id).catch(() => {}); return null; } parts.push(b); }
  const blob = new Blob(parts, { type: m.mime }); if (blob.size !== m.size) { await remove(id).catch(() => {}); return null; }
  return URL.createObjectURL(blob);
}
export async function artUrl(id) { const m = await tx('meta', 'readonly', (s) => rq(s.get(id))); return m?.art ? URL.createObjectURL(m.art) : null; }
export async function removeAll() { for (const m of await list()) await remove(m.id); }
