// Freehand stroke maths: simplify, render outline, erase, transform. Points are flat [x, y, p, x, y, p, ...] relative to the item's (x, y).
// p is pen pressure 0..1 (0.5 when the device has none).
import { segDist } from './geom.js';
export const STROKE_TOOLS = { pen: { size: 4, opacity: 1 }, pencil: { size: 2, opacity: 0.8 }, highlighter: { size: 18, opacity: 0.35 } };
export const ptsCount = (pts) => Math.floor(pts.length / 3);
// Ramer-Douglas-Peucker on [x,y,p] triples; keeps pressure of surviving points.
export function simplify(pts, tol = 0.6) {
  const n = ptsCount(pts); if (n < 3) return pts.slice(); const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; for (let i = a + 1; i < b; i++) { const d = segDist(pts[i * 3], pts[i * 3 + 1], pts[a * 3], pts[a * 3 + 1], pts[b * 3], pts[b * 3 + 1]); if (d > md) { md = d; mi = i; } } if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]); return out;
}
export const r2 = (v) => Math.round(v * 100) / 100;
export function bounds(pts) { const n = ptsCount(pts); if (!n) return { x: 0, y: 0, w: 0, h: 0 }; let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (let i = 0; i < n; i++) { const x = pts[i * 3], y = pts[i * 3 + 1]; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; } return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; }
// Build a stroke item from raw world points. The item's box is the stroke's bounds padded by half its width.
export function makeStroke(raw, { tool = 'pen', color = '#f2f2f2', size, opacity }) {
  const base = STROKE_TOOLS[tool] || STROKE_TOOLS.pen, sz = size ?? base.size, pts = simplify(raw, tool === 'highlighter' ? 1.2 : 0.5), b = bounds(pts), pd = sz / 2 + 1;
  const ox = b.x - pd, oy = b.y - pd, rel = []; for (let i = 0; i < ptsCount(pts); i++) rel.push(r2(pts[i * 3] - ox), r2(pts[i * 3 + 1] - oy), r2(pts[i * 3 + 2]));
  return { type: 'draw', tool, x: ox, y: oy, w: Math.max(b.w + pd * 2, 1), h: Math.max(b.h + pd * 2, 1), rot: 0, pts: rel, color, size: sz, opacity: opacity ?? base.opacity, vw: b.w + pd * 2, vh: b.h + pd * 2 };
}
const widthAt = (it, p) => (it.tool === 'highlighter' ? it.size : it.size * (0.45 + 1.1 * p));
// SVG path data. Constant width -> a smoothed polyline; varying pressure -> a filled outline.
export function strokePath(it) {
  const pts = it.pts, n = ptsCount(pts); if (!n) return { d: '', fill: false };
  const sx = it.vw ? it.w / it.vw : 1, sy = it.vh ? it.h / it.vh : 1;
  const P = (i) => [pts[i * 3] * sx, pts[i * 3 + 1] * sy, pts[i * 3 + 2]];
  const varies = it.tool !== 'highlighter' && it.pressure && n > 2;
  if (!varies) {
    if (n === 1) { const [x, y] = P(0); return { d: `M${r2(x)} ${r2(y)}l0.01 0`, fill: false }; }
    let d = `M${r2(P(0)[0])} ${r2(P(0)[1])}`; for (let i = 1; i < n - 1; i++) { const [x, y] = P(i), [x2, y2] = P(i + 1); d += `Q${r2(x)} ${r2(y)} ${r2((x + x2) / 2)} ${r2((y + y2) / 2)}`; } const [lx, ly] = P(n - 1); return { d: d + `L${r2(lx)} ${r2(ly)}`, fill: false };
  }
  const L = [], R = []; for (let i = 0; i < n; i++) { const [x, y, p] = P(i), [x0, y0] = P(Math.max(0, i - 1)), [x1, y1] = P(Math.min(n - 1, i + 1)); let dx = x1 - x0, dy = y1 - y0; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; const w = widthAt(it, p) / 2; L.push([x - dy * w, y + dx * w]); R.push([x + dy * w, y - dx * w]); }
  const ring = [...L, ...R.reverse()]; return { d: 'M' + ring.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L') + 'Z', fill: true };
}
// Distance from a world point to a stroke (for hit tests / eraser).
export function strokeDist(it, wx, wy) { const pts = it.pts, n = ptsCount(pts), sx = it.vw ? it.w / it.vw : 1, sy = it.vh ? it.h / it.vh : 1; const px = wx - it.x, py = wy - it.y; if (n === 1) return Math.hypot(px - pts[0] * sx, py - pts[1] * sy); let best = Infinity; for (let i = 0; i < n - 1; i++) best = Math.min(best, segDist(px, py, pts[i * 3] * sx, pts[i * 3 + 1] * sy, pts[i * 3 + 3] * sx, pts[i * 3 + 4] * sy)); return best; }
// Partial (precise) eraser: removes the part of the stroke inside the circle and returns the surviving pieces as new stroke items.
// Returns null when nothing was hit, [] when everything was erased.
export function eraseFromStroke(it, wx, wy, radius) {
  const n = ptsCount(it.pts), sx = it.vw ? it.w / it.vw : 1, sy = it.vh ? it.h / it.vh : 1, px = wx - it.x, py = wy - it.y; const dense = [];
  for (let i = 0; i < n; i++) { const x = it.pts[i * 3] * sx, y = it.pts[i * 3 + 1] * sy, p = it.pts[i * 3 + 2]; if (i) { const [ax, ay, ap] = dense[dense.length - 1], d = Math.hypot(x - ax, y - ay), k = Math.ceil(d / Math.max(radius / 2, 1)); for (let j = 1; j < k; j++) dense.push([ax + ((x - ax) * j) / k, ay + ((y - ay) * j) / k, ap + ((p - ap) * j) / k]); } dense.push([x, y, p]); }
  let hit = false; const pieces = []; let cur = [];
  for (const [x, y, p] of dense) { if (Math.hypot(x - px, y - py) <= radius) { hit = true; if (cur.length) pieces.push(cur); cur = []; } else cur.push([x, y, p]); }
  if (cur.length) pieces.push(cur); if (!hit) return null;
  return pieces.filter((pc) => pc.length > 1).map((pc) => { const flat = pc.flatMap(([x, y, p]) => [x + it.x, y + it.y, p]); return { ...makeStroke(flat, { tool: it.tool, color: it.color, size: it.size, opacity: it.opacity }), pressure: it.pressure }; });
}
