// Boards persistence: debounced delta autosave, IndexedDB recovery journal, offline cache and retry.
// Only objects that changed are sent (never the whole board). Each request carries an opId so a retry never duplicates anything.
import { rawApi } from '../state.js';
const DB = 'pulsar-boards', rid = () => `op-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
let dbp; const open = () => (dbp ||= new Promise((res, rej) => { try { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { r.result.createObjectStore('kv'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
async function tx(mode, fn) { try { const d = await open(); return await new Promise((res, rej) => { const t = d.transaction('kv', mode); const out = fn(t.objectStore('kv')); t.oncomplete = () => res(out && 'result' in out ? out.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); } catch { return undefined; } }
export const kvGet = (k) => tx('readonly', (s) => s.get(k)); export const kvSet = (k, v) => tx('readwrite', (s) => s.put(v, k)); export const kvDel = (k) => tx('readwrite', (s) => s.delete(k));
export const sessionId = `s${Math.random().toString(36).slice(2, 10)}`;
export async function loadBoard(id) { // online: server (and refresh the offline copy). Offline: the copy on this device.
  try {
    const { board } = await rawApi('GET', `/boards/${id}`); const items = []; let off = 0;
    for (;;) { const r = await rawApi('GET', `/boards/${id}/items?offset=${off}&limit=1500`); items.push(...r.items); if (r.next == null) break; off = r.next; }
    kvSet(`board:${id}`, { board, items, at: Date.now() }); return { board, items, offline: false };
  } catch (e) { if (e.status) throw e; const c = await kvGet(`board:${id}`); if (!c) throw Object.assign(new Error('This board has not been saved for offline use yet. Open it once while online.'), { offline: true }); return { board: c.board, items: c.items, offline: true }; }
}
// createSaver(model, boardId, { onStatus, onConflict, getViewport })
export function createSaver(model, board, { onStatus = () => {}, onConflict = () => {}, getViewport = () => null } = {}) {
  let rev = board.rev, timer, inflight = false, dead = false, failures = 0, journalT; const id = board.id;
  const journalKey = `pending:${id}`;
  const lsKey = `pulsar:bd:pending:${id}`;
  const pendingNow = () => ({ upsert: [...model.dirty].map((i) => model.get(i)).filter(Boolean), remove: [...model.gone], at: Date.now() });
  const mirror = () => { // synchronous copy so even a reload mid-keystroke keeps the edit (IndexedDB writes can be cut off on unload)
    try { const p = pendingNow(); if (!p.upsert.length && !p.remove.length) localStorage.removeItem(lsKey); else { const s = JSON.stringify(p); if (s.length < 3e6) localStorage.setItem(lsKey, s); } } catch { /* storage full: IndexedDB journal still covers it */ } };
  const writeJournal = async () => { // survives reload/crash: exactly what has not reached the server yet
    mirror(); const { upsert, remove, at } = pendingNow(); if (!upsert.length && !remove.length) return kvDel(journalKey);
    return kvSet(journalKey, { upsert, remove, at });
  };
  const status = (s, msg) => onStatus(s, msg);
  async function flush({ force = false } = {}) {
    clearTimeout(timer); if (dead || inflight || !model.hasDirty) return true; if (!navigator.onLine) { status('offline'); return false; }
    inflight = true; status('saving'); const batch = model.takeDirty(); const chunks = []; let cur = { upsert: [], remove: [] }, size = 0;
    for (const it of batch.upsert) { const n = JSON.stringify(it).length; if (cur.upsert.length >= 400 || size + n > 1.5e6) { chunks.push(cur); cur = { upsert: [], remove: [] }; size = 0; } cur.upsert.push(it); size += n; }
    for (let i = 0; i < batch.remove.length; i += 2000) { if (i === 0 && cur.remove.length === 0) cur.remove = batch.remove.slice(0, 2000); else chunks.push({ upsert: [], remove: batch.remove.slice(i, i + 2000) }); } chunks.push(cur);
    const sent = { upsert: [], remove: [] };
    try {
      for (const c of chunks.filter((c) => c.upsert.length || c.remove.length)) { const r = await rawApi('POST', `/boards/${id}/ops`, { opId: c.opId ||= rid(), sid: sessionId, baseRev: rev, force, upsert: c.upsert, remove: c.remove, viewport: getViewport() }); rev = r.rev; sent.upsert.push(...c.upsert); sent.remove.push(...c.remove); }
      failures = 0; inflight = false; await writeJournal(); status(model.hasDirty ? 'unsaved' : 'saved'); if (model.hasDirty) schedule(); else cache(); return true;
    } catch (e) {
      inflight = false; const left = { upsert: batch.upsert.filter((it) => !sent.upsert.includes(it)), remove: batch.remove.filter((r) => !sent.remove.includes(r)) }; model.giveBack(left);
      if (e.status === 409) { status('conflict'); onConflict(); return false; }
      if (!e.status || e.offline) { status('offline'); await writeJournal(); return false; }
      failures++; status('error', e.message); await writeJournal(); if (failures < 5 && e.status >= 500) timer = setTimeout(() => flush(), Math.min(30000, 2000 * 2 ** failures)); return false;
    }
  }
  let cacheT; const cache = () => { clearTimeout(cacheT); cacheT = setTimeout(() => kvSet(`board:${id}`, { board: { ...board, rev }, items: model.all(), at: Date.now() }), 3000); };
  function schedule() { if (dead) return; status('unsaved'); clearTimeout(timer); timer = setTimeout(() => flush(), 1500); clearTimeout(journalT); mirror(); journalT = setTimeout(writeJournal, 150); }
  const unsub = model.on((e) => { if (e.src !== 'load') schedule(); });
  const online = () => { if (model.hasDirty) flush(); }; const hide = () => { mirror(); writeJournal(); if (document.visibilityState === 'hidden') flush(); }; addEventListener('online', online); document.addEventListener('visibilitychange', hide); addEventListener('pagehide', hide);
  return {
    flush, get rev() { return rev; }, setRev: (r) => { rev = r; },
    async recover() { let j = await kvGet(journalKey); let l = null; try { l = JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch { /* */ } if (l && (!j || (l.at || 0) >= (j.at || 0))) j = l; if (!j || (!j.upsert?.length && !j.remove?.length)) return 0; model.tx('Recover', (t) => { for (const it of j.upsert) t.put(it); for (const r of j.remove) t.del(r); }, { record: false, src: 'recover' }); schedule(); return j.upsert.length + j.remove.length; },
    dispose: async () => { dead = true; unsub(); clearTimeout(timer); removeEventListener('online', online); document.removeEventListener('visibilitychange', hide); removeEventListener('pagehide', hide); await writeJournal(); },
    async finalFlush() { dead = false; const ok = await flush(); return ok; },
  };
}
