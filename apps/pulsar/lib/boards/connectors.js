// Connector routing: straight, curved, elbow and freeform paths between item anchors or free points.
import { anchorPoint, bestSide, center, polyDist, unionRects } from './geom.js';
export const LABELS = ['Related to', 'Depends on', 'References', 'Contains', 'Created from', 'Leads to', 'Supports', 'Contradicts'];
const N = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const r = (v) => Math.round(v * 100) / 100;
function end(c, which, items, other) {
  const ref = c[which], free = which === 'from' ? c.p1 : c.p2, it = ref && items(ref.id);
  if (!it) { const p = free || { x: 0, y: 0 }; const dx = other.x - p.x, dy = other.y - p.y, [nx, ny] = Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1]; return { x: p.x, y: p.y, nx, ny, broken: !!ref }; }
  const side = !ref.side || ref.side === 'auto' ? bestSide(it, other.x, other.y) : ref.side; return anchorPoint(it, side);
}
function bez(a, b, c, d, t) { const u = 1 - t; return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y }; }
// Returns { pts (polyline), d (SVG path), startDir, endDir, mid (adjust handle), labelPos, bbox, s, e }.
export function route(c, items) {
  const fromIt = c.from && items(c.from.id), toIt = c.to && items(c.to.id);
  const aGuess = fromIt ? center(fromIt) : c.p1 || { x: 0, y: 0 }, bGuess = toIt ? center(toIt) : c.p2 || { x: 0, y: 0 };
  const s = end(c, 'from', items, c.pts?.[0] || bGuess), e = end(c, 'to', items, c.pts?.[c.pts.length - 1] || aGuess); void aGuess;
  const kind = c.route || 'curve'; let pts, d, mid;
  if (kind === 'straight') { pts = [s, e]; d = `M${r(s.x)} ${r(s.y)}L${r(e.x)} ${r(e.y)}`; mid = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }; }
  else if (kind === 'free') { pts = [s, ...(c.pts || []), e]; d = 'M' + pts.map((p) => `${r(p.x)} ${r(p.y)}`).join('L'); mid = pts[Math.floor(pts.length / 2)]; }
  else if (kind === 'elbow') {
    const g = 24, s0 = { x: s.x + s.nx * g, y: s.y + s.ny * g }, e0 = { x: e.x + e.nx * g, y: e.y + e.ny * g }, sh = Math.abs(s.nx) > 0.5, eh = Math.abs(e.nx) > 0.5, t = c.mid ?? 0.5; let p;
    if (sh && eh) { const mx = s0.x + (e0.x - s0.x) * t, ok = (s.nx > 0 ? mx >= s.x + 1 : mx <= s.x - 1) && (e.nx > 0 ? mx >= e.x + 1 : mx <= e.x - 1); p = ok ? [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e] : [s, s0, { x: s0.x, y: (s.y + e.y) / 2 }, { x: e0.x, y: (s.y + e.y) / 2 }, e0, e]; mid = ok ? { x: mx, y: (s.y + e.y) / 2 } : { x: (s0.x + e0.x) / 2, y: (s.y + e.y) / 2 }; }
    else if (!sh && !eh) { const my = s0.y + (e0.y - s0.y) * t, ok = (s.ny > 0 ? my >= s.y + 1 : my <= s.y - 1) && (e.ny > 0 ? my >= e.y + 1 : my <= e.y - 1); p = ok ? [s, { x: s.x, y: my }, { x: e.x, y: my }, e] : [s, s0, { x: (s.x + e.x) / 2, y: s0.y }, { x: (s.x + e.x) / 2, y: e0.y }, e0, e]; mid = ok ? { x: (s.x + e.x) / 2, y: my } : { x: (s.x + e.x) / 2, y: (s0.y + e0.y) / 2 }; }
    else if (sh) { p = [s, { x: e.x, y: s.y }, e]; mid = p[1]; } else { p = [s, { x: s.x, y: e.y }, e]; mid = p[1]; }
    pts = p; d = 'M' + pts.map((q) => `${r(q.x)} ${r(q.y)}`).join('L');
  } else { // curve
    const m = c.pts?.[0], dist = Math.hypot(e.x - s.x, e.y - s.y);
    if (!m) { const k = Math.max(40, dist * 0.4), c1 = { x: s.x + s.nx * k, y: s.y + s.ny * k }, c2 = { x: e.x + e.nx * k, y: e.y + e.ny * k }; pts = []; for (let i = 0; i <= 24; i++) pts.push(bez(s, c1, c2, e, i / 24)); d = `M${r(s.x)} ${r(s.y)}C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(e.x)} ${r(e.y)}`; mid = bez(s, c1, c2, e, 0.5); }
    else { const [tx, ty] = norm(e.x - s.x, e.y - s.y), d1 = Math.hypot(m.x - s.x, m.y - s.y) * 0.4, d2 = Math.hypot(e.x - m.x, e.y - m.y) * 0.4, c1 = { x: s.x + s.nx * d1, y: s.y + s.ny * d1 }, c2 = { x: m.x - tx * d1, y: m.y - ty * d1 }, c3 = { x: m.x + tx * d2, y: m.y + ty * d2 }, c4 = { x: e.x + e.nx * d2, y: e.y + e.ny * d2 }; pts = []; for (let i = 0; i <= 16; i++) pts.push(bez(s, c1, c2, m, i / 16)); for (let i = 1; i <= 16; i++) pts.push(bez(m, c3, c4, e, i / 16)); d = `M${r(s.x)} ${r(s.y)}C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(m.x)} ${r(m.y)}C${r(c3.x)} ${r(c3.y)} ${r(c4.x)} ${r(c4.y)} ${r(e.x)} ${r(e.y)}`; mid = m; }
  }
  const L = pts.length, [sdx, sdy] = norm(pts[0].x - pts[Math.min(1, L - 1)].x, pts[0].y - pts[Math.min(1, L - 1)].y), [edx, edy] = norm(pts[L - 1].x - pts[Math.max(0, L - 2)].x, pts[L - 1].y - pts[Math.max(0, L - 2)].y);
  const bbox = unionRects(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return { pts, d, mid, startDir: { x: sdx, y: sdy }, endDir: { x: edx, y: edy }, labelPos: pts[Math.floor((L - 1) / 2)] && labelAt(pts), bbox, s, e };
}
function labelAt(pts) { let tot = 0; const seg = []; for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); seg.push(l); tot += l; } let h = tot / 2; for (let i = 0; i < seg.length; i++) { if (h <= seg[i] || i === seg.length - 1) { const t = seg[i] ? h / seg[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; } h -= seg[i]; } return pts[0]; }
export const hitConnector = (g, x, y) => polyDist(g.pts, x, y);
// Arrowhead outline at a tip pointing along dir (dx, dy).
export function arrowPath(kind, tip, dir, size) {
  if (!kind || kind === 'none') return ''; const bx = tip.x - dir.x * size, by = tip.y - dir.y * size, px = -dir.y * size * 0.5, py = dir.x * size * 0.5;
  if (kind === 'open') return `M${r(bx + px)} ${r(by + py)}L${r(tip.x)} ${r(tip.y)}L${r(bx - px)} ${r(by - py)}`;
  if (kind === 'diamond') { const mx = tip.x - dir.x * size * 0.5, my = tip.y - dir.y * size * 0.5; return `M${r(tip.x)} ${r(tip.y)}L${r(mx + px)} ${r(my + py)}L${r(bx)} ${r(by)}L${r(mx - px)} ${r(my - py)}Z`; }
  if (kind === 'dot') { const cx = tip.x - dir.x * size * 0.4, cy = tip.y - dir.y * size * 0.4, q = size * 0.4; return `M${r(cx - q)} ${r(cy)}a${r(q)} ${r(q)} 0 1 0 ${r(q * 2)} 0a${r(q)} ${r(q)} 0 1 0 ${r(-q * 2)} 0Z`; }
  return `M${r(tip.x)} ${r(tip.y)}L${r(bx + px)} ${r(by + py)}L${r(bx - px)} ${r(by - py)}Z`;
}
