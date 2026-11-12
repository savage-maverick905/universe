// Pulsar Boards geometry. Pure functions, no DOM: shared by the editor, the exporter and the tests.
// World coordinates are plain JS doubles (about +-9e15 exact), so the canvas has no fixed size. An item is
// { x, y, w, h, rot } where (x, y) is the top-left of the UNROTATED box and rot is degrees about its centre.
// The camera is { x, y, z }: (x, y) is the world point at the top-left of the screen, z the zoom (screen px per world unit).
export const Z_MIN = 0.02, Z_MAX = 8;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rad = (d) => (d * Math.PI) / 180;
export const toScreen = (cam, wx, wy) => ({ x: (wx - cam.x) * cam.z, y: (wy - cam.y) * cam.z });
export const toWorld = (cam, sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });
export function zoomAt(cam, sx, sy, nz) { const z = clamp(nz, Z_MIN, Z_MAX), w = toWorld(cam, sx, sy); return { z, x: w.x - sx / z, y: w.y - sy / z }; }
export function fitCamera(r, vw, vh, pad = 48, maxZ = 2) { const w = Math.max(r.w, 1), h = Math.max(r.h, 1), z = clamp(Math.min((vw - pad * 2) / w, (vh - pad * 2) / h), Z_MIN, maxZ); return { z, x: r.x + w / 2 - vw / 2 / z, y: r.y + h / 2 - vh / 2 / z }; }

export const center = (it) => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });
export function rotatePoint(px, py, cx, cy, deg) { if (!deg) return { x: px, y: py }; const a = rad(deg), c = Math.cos(a), s = Math.sin(a), dx = px - cx, dy = py - cy; return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }; }
export function corners(it) { const c = center(it); return [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]].map(([x, y]) => rotatePoint(x, y, c.x, c.y, it.rot || 0)); }
export function aabb(it) { if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h }; const cs = corners(it), xs = cs.map((p) => p.x), ys = cs.map((p) => p.y), x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
export function unionRects(rs) { if (!rs.length) return null; let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (const r of rs) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); } return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; }
export const rectsHit = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
export const rectHasPoint = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const rectInside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
export function pointInItem(it, px, py, slop = 0) { const c = center(it), p = rotatePoint(px, py, c.x, c.y, -(it.rot || 0)); return p.x >= it.x - slop && p.x <= it.x + it.w + slop && p.y >= it.y - slop && p.y <= it.y + it.h + slop; }

// ---- distances ----
export function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
export function polyDist(pts, px, py) { let best = Infinity; for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, segDist(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)); if (pts.length === 1) best = Math.hypot(px - pts[0].x, py - pts[0].y); return best; }
export function pointInPolygon(poly, x, y) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside; } return inside; }

// ---- anchors (connection handles) ----
export const SIDES = ['top', 'right', 'bottom', 'left'];
const NORMAL = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
// World position and outward direction of a side's midpoint (rotation aware).
export function anchorPoint(it, side) {
  const c = center(it), n = NORMAL[side] || NORMAL.right;
  const local = { x: c.x + (n[0] * it.w) / 2, y: c.y + (n[1] * it.h) / 2 }, p = rotatePoint(local.x, local.y, c.x, c.y, it.rot || 0);
  const d = rotatePoint(c.x + n[0], c.y + n[1], c.x, c.y, it.rot || 0);
  return { x: p.x, y: p.y, nx: d.x - c.x, ny: d.y - c.y, side };
}
// "auto" anchors pick whichever side faces the other end.
export function bestSide(it, tx, ty) { const c = center(it), a = rotatePoint(tx, ty, c.x, c.y, -(it.rot || 0)), dx = (a.x - c.x) / Math.max(it.w, 1), dy = (a.y - c.y) / Math.max(it.h, 1); return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top'; }
export function nearestAnchor(it, wx, wy) { let best = null; for (const s of SIDES) { const p = anchorPoint(it, s), d = Math.hypot(p.x - wx, p.y - wy); if (!best || d < best.d) best = { ...p, d }; } return best; }

// ---- snapping, alignment ----
export const snap = (v, grid) => (grid > 0 ? Math.round(v / grid) * grid : v);
export function alignPatches(items, mode) {
  if (items.length < 2) return [];
  const bs = items.map((it) => ({ it, b: aabb(it) })), U = unionRects(bs.map((x) => x.b));
  return bs.map(({ it, b }) => { let dx = 0, dy = 0;
    if (mode === 'left') dx = U.x - b.x; else if (mode === 'right') dx = U.x + U.w - (b.x + b.w); else if (mode === 'hcenter') dx = U.x + U.w / 2 - (b.x + b.w / 2);
    else if (mode === 'top') dy = U.y - b.y; else if (mode === 'bottom') dy = U.y + U.h - (b.y + b.h); else if (mode === 'vcenter') dy = U.y + U.h / 2 - (b.y + b.h / 2);
    return { id: it.id, patch: { x: it.x + dx, y: it.y + dy } }; });
}
export function distributePatches(items, axis) {
  if (items.length < 3) return [];
  const k = axis === 'h' ? 'x' : 'y', s = axis === 'h' ? 'w' : 'h';
  const bs = items.map((it) => ({ it, b: aabb(it) })).sort((a, b) => a.b[k] - b.b[k]), first = bs[0].b, last = bs[bs.length - 1].b;
  const total = last[k] + last[s] - first[k], used = bs.reduce((a, x) => a + x.b[s], 0), gap = (total - used) / (bs.length - 1); let pos = first[k];
  return bs.map(({ it, b }) => { const d = pos - b[k]; pos += b[s] + gap; return { id: it.id, patch: { [k]: it[k] + d } }; });
}

// ---- spatial grid index: lets the editor find what is on screen / under the pointer without scanning every item ----
export class SpatialIndex {
  constructor(cell = 512) { this.cell = cell; this.cells = new Map(); this.rects = new Map(); }
  _keys(r) { const c = this.cell, out = [], x1 = Math.floor(r.x / c), x2 = Math.floor((r.x + r.w) / c), y1 = Math.floor(r.y / c), y2 = Math.floor((r.y + r.h) / c); if ((x2 - x1 + 1) * (y2 - y1 + 1) > 4096) return null; for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) out.push(`${x},${y}`); return out; }
  set(id, r) { this.remove(id); const ks = this._keys(r); this.rects.set(id, { r, ks }); if (!ks) { (this.big ||= new Set()).add(id); return; } for (const k of ks) (this.cells.get(k) || this.cells.set(k, new Set()).get(k)).add(id); }
  remove(id) { const e = this.rects.get(id); if (!e) return; if (e.ks) for (const k of e.ks) { const s = this.cells.get(k); if (s) { s.delete(id); if (!s.size) this.cells.delete(k); } } else this.big?.delete(id); this.rects.delete(id); }
  query(r) { const out = new Set(), ks = this._keys(r); if (!ks) { for (const [id, e] of this.rects) if (rectsHit(e.r, r)) out.add(id); return out; } for (const k of ks) for (const id of this.cells.get(k) || []) if (!out.has(id) && rectsHit(this.rects.get(id).r, r)) out.add(id); if (this.big) for (const id of this.big) if (rectsHit(this.rects.get(id).r, r)) out.add(id); return out; }
  get size() { return this.rects.size; }
}
