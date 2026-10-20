// Tiny dependency-free SVG charts. Everything is built with createElementNS, never innerHTML.
// Display only: all real money arithmetic happens on the server. Here we only scale numbers onto a canvas.
import { money, axisMoney, monthLabel, symbolOf } from './fmt.js';
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
const div = (cls, ...kids) => { const d = document.createElement('div'); if (cls) d.className = cls; for (const c of kids.flat()) if (c != null) d.append(c.nodeType ? c : document.createTextNode(c)); return d; };
const span = (cls, text) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
let uid = 0;
export const PALETTE = ['#00ADEF', '#ED6627', '#3DD68C', '#F5B93C', '#A78BFA', '#FF8589', '#2DD4BF', '#F472B6'];
export const colorAt = (i) => PALETTE[i % PALETTE.length];

// "Nice" axis: round step (1, 2, 5 x 10^k), ticks that bracket the data.
function scale(min, max, count = 4) {
  const span_ = max - min || 1, p = 10 ** Math.floor(Math.log10(span_ / count)), f = span_ / count / p, step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { ticks, lo, hi: hi === lo ? lo + step : hi };
}
// A line of text under a chart that shows exact amounts for whatever was tapped.
function readout(hint) {
  const box = div('readout'); box.setAttribute('aria-live', 'polite'); box.textContent = hint;
  return { node: box, show: (title, rows) => box.replaceChildren(span('rt', title), ...rows.flatMap(([label, text, cls]) => [span('rl', label), span(`rv ${cls || ''}`.trim(), text)])) };
}
const grid = (svg, ticks, y, x1, x2, code, labelX) => ticks.forEach((v) => {
  svg.append(el('line', { x1, x2, y1: y(v), y2: y(v), class: v === 0 ? 'axis0' : 'gridl' }));
  svg.append(el('text', { x: labelX, y: y(v) + 3.5, 'text-anchor': 'end', class: 'ct' }, axisMoney(v, code)));
});
const every = (n, max) => Math.max(1, Math.ceil(n / max));

// Paired bars per bucket: income (green) and spending (orange), with gridlines, a money axis and values on top.
export function barChart(points, code, { height = 200 } = {}) {
  const id = ++uid, W = 340, H = height, pad = { t: 14, b: 24, l: 34, r: 6 }, n = Math.max(points.length, 1), max = Math.max(1, ...points.flatMap((p) => [p.income, p.expense]));
  const sc = scale(0, max), y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - sc.lo) / (sc.hi - sc.lo)), slot = (W - pad.l - pad.r) / n, bw = Math.max(2, Math.min(16, slot / 2.4)), step = every(n, 8);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Income compared with spending, by period' });
  svg.append(el('defs', {}, ...[['i', '#3DD68C', '#1f9d63'], ['e', '#F27A40', '#c4501b']].map(([k, a, b]) => el('linearGradient', { id: `bg${id}${k}`, x1: 0, x2: 0, y1: 0, y2: 1 }, el('stop', { offset: '0%', 'stop-color': a }), el('stop', { offset: '100%', 'stop-color': b })))));
  grid(svg, sc.ticks, y, pad.l, W - pad.r, code, pad.l - 5);
  const rd = readout('Tap a bar to see the exact amounts');
  const showLabels = n <= 7, base = y(0), sel = el('rect', { class: 'selbar', x: 0, y: pad.t, width: slot, height: H - pad.t - pad.b, rx: 6, opacity: 0 });
  svg.append(sel);
  points.forEach((p, i) => {
    const cx = pad.l + slot * i + slot / 2, hh = (v) => (v ? Math.max(2, base - y(v)) : 0);
    const pick = () => { sel.setAttribute('x', pad.l + slot * i); sel.setAttribute('opacity', 1); rd.show(monthLabel(p.key), [['Income', money(p.income, code), 'pos'], ['Spent', money(p.expense, code), 'neg'], ['Net', money(p.income - p.expense, code, { sign: true }), p.income - p.expense >= 0 ? 'pos' : 'neg']]); };
    const g = el('g', { class: 'bargrp', tabindex: 0, role: 'button', 'aria-label': `${monthLabel(p.key)}: income ${money(p.income, code)}, spent ${money(p.expense, code)}` }, el('title', {}, `${monthLabel(p.key)} · Income ${money(p.income, code)} · Spent ${money(p.expense, code)}`));
    g.append(el('rect', { x: pad.l + slot * i, y: pad.t, width: slot, height: H - pad.t - pad.b, fill: 'transparent' }));
    for (const [v, dx, k] of [[p.income, -bw - 1, 'i'], [p.expense, 1, 'e']]) {
      g.append(el('rect', { x: cx + dx, y: base - hh(v), width: bw, height: hh(v), rx: Math.min(4, bw / 2), fill: `url(#bg${id}${k})` }));
      if (showLabels && v) g.append(el('text', { x: cx + dx + bw / 2, y: base - hh(v) - 4, 'text-anchor': 'middle', class: 'vl' }, axisMoney(v, code)));
    }
    g.addEventListener('click', pick); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    svg.append(g);
    if (i % step === 0) svg.append(el('text', { x: cx, y: H - 7, 'text-anchor': 'middle', class: 'ct' }, monthLabel(p.key)));
  });
  return div('chartbox', svg, rd.node);
}

// Running line (cumulative cash flow): area under the line, gridlines, a zero line and the latest value called out.
// `points` are { key, cumulativeMinor }.
export function lineChart(points, code, { height = 190 } = {}) {
  const id = ++uid, W = 340, H = height, pad = { t: 22, b: 24, l: 34, r: 14 }, vals = points.map((p) => p.cumulativeMinor), n = Math.max(vals.length - 1, 1);
  const sc = scale(Math.min(0, ...vals), Math.max(0, ...vals)), x = (i) => pad.l + ((W - pad.l - pad.r) * i) / n, y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - sc.lo) / (sc.hi - sc.lo)), step = every(vals.length, 6);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Running total of income minus spending' });
  svg.append(el('defs', {}, el('linearGradient', { id: `lg${id}`, x1: 0, x2: 0, y1: 0, y2: 1 }, el('stop', { offset: '0%', 'stop-color': '#00ADEF', 'stop-opacity': 0.4 }), el('stop', { offset: '100%', 'stop-color': '#00ADEF', 'stop-opacity': 0 }))));
  grid(svg, sc.ticks, y, pad.l, W - pad.r, code, pad.l - 5);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  if (vals.length > 1) svg.append(el('path', { d: `${line}L${x(vals.length - 1).toFixed(1)} ${y(0).toFixed(1)}L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z`, fill: `url(#lg${id})` }));
  svg.append(el('path', { d: line, fill: 'none', stroke: 'var(--blue)', 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = vals.length - 1, rd = readout('Tap the chart to see the running total on any day');
  const dot = el('circle', { r: 4.5, cx: x(last), cy: y(vals[last]), fill: 'var(--bg)', stroke: 'var(--blue)', 'stroke-width': 2.5 });
  const tag = el('text', { x: Math.min(x(last), W - pad.r), y: y(vals[last]) - 9, 'text-anchor': 'end', class: `vl ${vals[last] >= 0 ? 'pos' : 'neg'}` }, axisMoney(vals[last], code));
  svg.append(dot, tag);
  const pick = (i) => { dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(vals[i])); tag.setAttribute('x', Math.min(Math.max(x(i), pad.l + 20), W - pad.r)); tag.setAttribute('y', y(vals[i]) - 9); tag.textContent = axisMoney(vals[i], code); rd.show(monthLabel(points[i].key), [['Running total', money(vals[i], code, { sign: true }), vals[i] >= 0 ? 'pos' : 'neg']]); };
  const slot = (W - pad.l - pad.r) / Math.max(vals.length, 1);
  points.forEach((p, i) => {
    const hit = el('rect', { x: Math.max(pad.l, x(i) - slot / 2), y: pad.t, width: slot, height: H - pad.t - pad.b, fill: 'transparent', tabindex: 0, role: 'button', 'aria-label': `${monthLabel(p.key)}: running total ${money(p.cumulativeMinor, code)}` }, el('title', {}, `${monthLabel(p.key)} · ${money(p.cumulativeMinor, code)}`));
    hit.addEventListener('click', () => pick(i)); hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(i); } });
    svg.append(hit);
    if (i % step === 0 || i === last && step === 1) svg.append(el('text', { x: x(i), y: H - 7, 'text-anchor': 'middle', class: 'ct' }, monthLabel(p.key)));
  });
  return div('chartbox', svg, rd.node);
}

// Ring chart. items: [{ label, share (0..1), color, text }]. The centre shows `centre` (a big value) and `caption`.
export function donutChart(items, { centre = '', caption = '' } = {}) {
  const S = 168, R = 62, C = 2 * Math.PI * R, svg = el('svg', { viewBox: `0 0 ${S} ${S}`, class: 'donut', role: 'img', 'aria-label': 'Share of the total by category' });
  svg.append(el('circle', { cx: S / 2, cy: S / 2, r: R, fill: 'none', stroke: 'var(--raise)', 'stroke-width': 22 }));
  let acc = 0;
  for (const it of items) {
    const len = Math.max(0, it.share * C), gap = items.length > 1 && len > 3 ? 2 : 0;
    svg.append(el('circle', { cx: S / 2, cy: S / 2, r: R, fill: 'none', stroke: it.color, 'stroke-width': 22, 'stroke-dasharray': `${Math.max(0.5, len - gap)} ${C - Math.max(0.5, len - gap)}`, 'stroke-dashoffset': -acc, transform: `rotate(-90 ${S / 2} ${S / 2})` }, el('title', {}, `${it.label} · ${it.text}`)));
    acc += len;
  }
  svg.append(el('text', { x: S / 2, y: S / 2 + 2, 'text-anchor': 'middle', class: 'dc-big' }, centre), el('text', { x: S / 2, y: S / 2 + 18, 'text-anchor': 'middle', class: 'ct' }, caption));
  return svg;
}

export function progress(percent, state = 'ok') {
  const d = document.createElement('div'), i = document.createElement('i');
  d.className = `prog ${state}`; d.setAttribute('role', 'progressbar'); d.setAttribute('aria-valuemin', '0'); d.setAttribute('aria-valuemax', '100'); d.setAttribute('aria-valuenow', String(Math.min(100, Math.round(percent))));
  i.style.width = `${Math.max(0, Math.min(100, percent))}%`; d.append(i); return d;
}
export { symbolOf };
