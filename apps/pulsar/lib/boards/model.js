// Board model: items by id, spatial index, connector dependency map, undo/redo, and dirty tracking for autosave.
// Items are treated as immutable: every change replaces the object, so history can hold the old one.
import { SpatialIndex, aabb, pad } from './geom.js';
import { route } from './connectors.js';
export const uid = (p = 'o') => `${p}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
export class BoardModel {
  constructor() { this.items = new Map(); this.index = new SpatialIndex(); this.deps = new Map(); this.undoS = []; this.redoS = []; this.dirty = new Set(); this.gone = new Set(); this.subs = new Set(); this.live = null; this.maxZ = 0; this.depth = 0; this.cur = null; this.limit = 200; }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(ids, removed, src) { for (const f of this.subs) f({ ids, removed, src }); }
  get(id) { return this.items.get(id); }
  all() { return [...this.items.values()]; }
  fn() { return (id) => this.items.get(id); }
  load(list) { this.items.clear(); this.index = new SpatialIndex(); this.deps.clear(); this.undoS = []; this.redoS = []; this.maxZ = 0; for (const it of list) this._put(it); this.dirty.clear(); this.gone.clear(); this.emit(new Set(this.items.keys()), new Set(), 'load'); }
  rect(it) { if (it.type === 'connector') { const g = route(it, this.fn()); return pad(g.bbox || { x: 0, y: 0, w: 0, h: 0 }, 40); } return pad(aabb(it), it.type === 'draw' ? 2 : 4); }
  _dep(it, add) { if (it.type !== 'connector') return; for (const k of ['from', 'to']) if (it[k]?.id) { const s = this.deps.get(it[k].id) || this.deps.set(it[k].id, new Set()).get(it[k].id); add ? s.add(it.id) : s.delete(it.id); } }
  _put(it) { const old = this.items.get(it.id); if (old) this._dep(old, false); this.items.set(it.id, it); this._dep(it, true); if ((it.z || 0) > this.maxZ) this.maxZ = it.z || 0; this.index.set(it.id, this.rect(it)); }
  _del(id) { const old = this.items.get(id); if (!old) return; this._dep(old, false); this.items.delete(id); this.index.remove(id); this.deps.delete(id); }
  // Re-index connectors attached to moved items.
  _touchConns(ids, out) { for (const id of ids) for (const c of this.deps.get(id) || []) { const ci = this.items.get(c); if (ci) { this.index.set(c, this.rect(ci)); out.add(c); } } }
  // Run fn(tx) as ONE undo step. tx.put(item) / tx.del(id) / tx.patch(id, p).
  tx(label, fn, { record = true, src = 'user', collect = null } = {}) {
    const rec = new Map(), ids = new Set(), removed = new Set();
    const note = (id) => { if (!rec.has(id)) rec.set(id, this.items.get(id) || null); };
    const t = {
      put: (it) => { note(it.id); if (!it.z) it = { ...it, z: ++this.maxZ }; this._put(it); ids.add(it.id); removed.delete(it.id); this.dirty.add(it.id); this.gone.delete(it.id); },
      patch: (id, p) => { const o = this.items.get(id); if (!o) return; t.put({ ...o, ...p, ...(p.style ? { style: { ...(o.style || {}), ...p.style } } : {}) }); },
      del: (id) => { if (!this.items.has(id)) return; note(id); this._del(id); ids.delete(id); removed.add(id); this.dirty.delete(id); this.gone.add(id); },
    };
    const r = fn(t); this._touchConns([...ids, ...removed], ids);
    // deleting an item also deletes connectors that were attached ONLY to it? No: they keep free endpoints so no work is lost.
    for (const id of removed) for (const c of [...(this.deps.get(id) || [])]) { /* deps map was cleared with the item */ void c; }
    if ((record || collect) && rec.size) { const ch = []; for (const [id, before] of rec) { const after = this.items.get(id) || null; if (before !== after) ch.push({ id, before, after }); } if (ch.length) { if (collect) collect.push(...ch); else { this.undoS.push({ label, ch }); if (this.undoS.length > this.limit) this.undoS.shift(); this.redoS = []; } } }
    if (ids.size || removed.size) this.emit(ids, removed, src); return r;
  }
  // Merge a list of changes gathered with tx(..., { collect }) into ONE undo step (first `before`, last `after` per object).
  pushUndo(label, list) { const m = new Map(); for (const c of list) m.set(c.id, m.has(c.id) ? { id: c.id, before: m.get(c.id).before, after: c.after } : c); const ch = [...m.values()].filter((c) => c.before !== c.after); if (ch.length) { this.undoS.push({ label, ch }); this.redoS = []; } }
  // Live (drag) edits: applied immediately without history; endLive() records them as one step.
  beginLive() { this.live = new Map(); }
  livePatch(list) { const ids = new Set(); for (const { id, patch } of list) { const o = this.items.get(id); if (!o) continue; if (this.live && !this.live.has(id)) this.live.set(id, o); this._put({ ...o, ...patch, ...(patch.style ? { style: { ...(o.style || {}), ...patch.style } } : {}) }); ids.add(id); this.dirty.add(id); } this._touchConns([...ids], ids); this.emit(ids, new Set(), 'live'); }
  endLive(label) { if (!this.live) return; const ch = []; for (const [id, before] of this.live) { const after = this.items.get(id); if (after && before !== after && JSON.stringify(before) !== JSON.stringify(after)) ch.push({ id, before, after }); } this.live = null; if (ch.length) { this.undoS.push({ label, ch }); this.redoS = []; } }
  cancelLive() { if (!this.live) return; const ids = new Set(); for (const [id, b] of this.live) { this._put(b); ids.add(id); } this.live = null; this._touchConns([...ids], ids); this.emit(ids, new Set(), 'live'); }
  _apply(ch, dir) { const ids = new Set(), removed = new Set(); for (const c of ch) { const to = dir === 'undo' ? c.before : c.after; if (to) { this._put(to); ids.add(c.id); this.dirty.add(c.id); this.gone.delete(c.id); } else { this._del(c.id); removed.add(c.id); this.dirty.delete(c.id); this.gone.add(c.id); } } this._touchConns([...ids, ...removed], ids); this.emit(ids, removed, dir); }
  undo() { const s = this.undoS.pop(); if (!s) return null; this._apply(s.ch, 'undo'); this.redoS.push(s); return s.label; }
  redo() { const s = this.redoS.pop(); if (!s) return null; this._apply(s.ch, 'redo'); this.undoS.push(s); return s.label; }
  // Autosave support: take what changed since the last save; give it back if the save fails.
  takeDirty() { const upsert = [...this.dirty].map((id) => this.items.get(id)).filter(Boolean), remove = [...this.gone]; this.dirty.clear(); this.gone.clear(); return { upsert, remove }; }
  giveBack({ upsert, remove }) { for (const it of upsert) if (this.items.has(it.id)) this.dirty.add(it.id); for (const id of remove) if (!this.items.has(id)) this.gone.add(id); }
  get hasDirty() { return this.dirty.size > 0 || this.gone.size > 0; }
  bounds() { let r = null; for (const it of this.items.values()) { if (it.type === 'connector') continue; const b = aabb(it); r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), w: 0, h: 0, x2: Math.max(r.x2, b.x + b.w), y2: Math.max(r.y2, b.y + b.h) } : { x: b.x, y: b.y, w: 0, h: 0, x2: b.x + b.w, y2: b.y + b.h }; } return r && { x: r.x, y: r.y, w: r.x2 - r.x, h: r.y2 - r.y }; }
}
