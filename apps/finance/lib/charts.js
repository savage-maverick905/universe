// Tiny dependency-free SVG charts. Everything is built with createElementNS, never innerHTML.
import { money, monthLabel } from './fmt.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };

// Paired bars per bucket: income (blue) and spending (orange).
export function barChart(points, code, { height = 150 } = {}) {
  const W = 320, H = height, pad = { t: 8, b: 22, l: 4, r: 4 }, max = Math.max(1, ...points.flatMap((p) => [p.income, p.expense])), n = Math.max(points.length, 1), slot = (W - pad.l - pad.r) / n, bw = Math.min(14, slot / 2.6);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Income compared with spending' });
  points.forEach((p, i) => {
    const x = pad.l + slot * i + slot / 2, bh = (v) => Math.max(v ? 2 : 0, ((H - pad.t - pad.b) * v) / max);
    svg.append(el('rect', { x: x - bw - 1, y: H - pad.b - bh(p.income), width: bw, height: bh(p.income), rx: 3, fill: 'var(--blue)' }, el('title', {}, `Income ${money(p.income, code)}`)));
    svg.append(el('rect', { x: x + 1, y: H - pad.b - bh(p.expense), width: bw, height: bh(p.expense), rx: 3, fill: 'var(--orange)' }, el('title', {}, `Spent ${money(p.expense, code)}`)));
    if (n <= 12 || i % Math.ceil(n / 8) === 0) svg.append(el('text', { x, y: H - 6, 'text-anchor': 'middle', class: 'ct' }, monthLabel(p.key)));
  });
  return svg;
}
// Running line (cumulative cash flow); can go below zero.
export function lineChart(values, { height = 120 } = {}) {
  const W = 320, H = height, pad = 8, min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min || 1, n = Math.max(values.length - 1, 1);
  const x = (i) => pad + ((W - pad * 2) * i) / n, y = (v) => H - pad - ((H - pad * 2) * (v - min)) / span;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Cumulative cash flow' });
  svg.append(el('line', { x1: pad, x2: W - pad, y1: y(0), y2: y(0), stroke: 'var(--line-strong)', 'stroke-dasharray': '3 3' }));
  if (values.length) svg.append(el('path', { d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(''), fill: 'none', stroke: 'var(--blue)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return svg;
}
export function progress(percent, state = 'ok') {
  const d = document.createElement('div'), i = document.createElement('i');
  d.className = `prog ${state}`; d.setAttribute('role', 'progressbar'); d.setAttribute('aria-valuemin', '0'); d.setAttribute('aria-valuemax', '100'); d.setAttribute('aria-valuenow', String(Math.min(100, Math.round(percent))));
  i.style.width = `${Math.max(0, Math.min(100, percent))}%`; d.append(i); return d;
}
