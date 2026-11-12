// DOM renderers for every board object type. renderItem(it, el, env) creates or updates the element for one object.
// Position/rotation are applied with a transform so dragging never re-lays-out the page; content is rebuilt only when it changed.
import { h, icon } from '../state.js';
import { sanitizeRich } from './rich.js';
import { strokePath } from './strokes.js';
import { cardBody, cached } from './resources.js';
import { DEFAULTS, shapePath } from './shapes.js';
export { DEFAULTS, shapePath };
export const FONTS = { sans: 'var(--font)', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace', hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive' };
export const st = (it, k) => it.style?.[k] ?? DEFAULTS[it.type]?.[k];
const NS = 'http://www.w3.org/2000/svg'; const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const hexA = (c) => c; // CSS and SVG both accept #rrggbbaa
function textStyle(it) { const s = it.style || {}; const d = DEFAULTS[it.type] || {}; const g = (k) => s[k] ?? d[k]; return `font-size:${g('size') || 16}px;color:${g('color') || '#f2f2f2'};text-align:${g('align') || 'left'};font-family:${FONTS[g('font')] || FONTS.sans};font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};text-decoration:${s.underline ? 'underline' : 'none'};line-height:${s.lh || 1.35};`; }
const rt = (field, html, cls = '') => { const e = h('div', { class: `bd-rt ${cls}`, 'data-field': field }); e.innerHTML = sanitizeRich(html || ''); return e; };
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const FILE_ICON = (m) => (m === 'application/pdf' ? 'file' : /^text\//.test(m) || m === 'application/json' ? 'paperclip' : m === 'application/zip' ? 'archive' : /sheet|csv/.test(m) ? 'table' : 'paperclip');
// Which keys change what the element looks like (everything except placement).
const SKIP = new Set(['x', 'y', 'rot', 'z', 'locked', 'hidden', 'group']);
const sameContent = (a, b) => { for (const k in a) if (!SKIP.has(k) && a[k] !== b[k]) return false; for (const k in b) if (!SKIP.has(k) && !(k in a)) return false; return true; };
export function renderItem(it, el, env = {}) {
  if (!el) { el = h('div', { class: `bd-it bd-${it.type}`, 'data-id': it.id }); el._it = null; }
  const prev = el._it; el._it = it;
  el.style.transform = `translate(${it.x}px,${it.y}px)${it.rot ? ` rotate(${it.rot}deg)` : ''}`; el.style.width = `${it.w}px`; el.style.height = `${it.h}px`; el.style.zIndex = String(Math.round(it.z || 1));
  el.classList.toggle('hidden', !!it.hidden); el.classList.toggle('locked', !!it.locked);
  if (prev && sameContent(prev, it) && !(it.type === 'resource' && env.dirtyRes)) return el;
  const w = it.w, hh = it.h; let inner;
  switch (it.type) {
    case 'text': { const s = it.style || {}; inner = h('div', { class: 'bd-in', style: `${textStyle(it)}padding:${st(it, 'pad')}px;background:${hexA(st(it, 'bg'))};border:${st(it, 'bw') || 0}px solid ${st(it, 'border')};border-radius:${s.radius || 0}px;` }, rt('html', it.html)); break; }
    case 'sticky': inner = h('div', { class: 'bd-in bd-stk', style: `${textStyle(it)}padding:${st(it, 'pad')}px;background:${st(it, 'bg')};` }, rt('html', it.html)); break;
    case 'shape': { const s = svg('svg', { width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, class: 'bd-svg' }), line = it.kind === 'line'; const p = svg('path', { d: shapePath(it.kind, w, hh), fill: line ? 'none' : hexA(st(it, 'fill')), stroke: hexA(st(it, 'stroke')), 'stroke-width': st(it, 'sw'), 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: st(it, 'opacity') }); s.append(p);
      inner = h('div', { class: 'bd-in bd-shp' }, s, line ? null : h('div', { class: 'bd-lbl', style: textStyle(it) }, rt('html', it.html))); break; }
    case 'frame': inner = h('div', { class: 'bd-in bd-frm', style: `--fc:${it.color || '#ff6b1a'}` }, h('div', { class: 'bd-ftitle bd-rt', 'data-field': 'title' }, it.title || 'Frame'), h('div', { class: 'bd-fbody' })); break;
    case 'draw': { const { d, fill } = strokePath(it), s = svg('svg', { width: it.w, height: it.h, viewBox: `0 0 ${it.w} ${it.h}`, class: 'bd-svg' }); const p = svg('path', fill ? { d, fill: it.color, opacity: it.opacity } : { d, fill: 'none', stroke: it.color, 'stroke-width': it.size, 'stroke-linecap': it.tool === 'highlighter' ? 'butt' : 'round', 'stroke-linejoin': 'round', opacity: it.opacity }); if (it.tool === 'highlighter') s.style.mixBlendMode = 'screen'; s.append(p); inner = h('div', { class: 'bd-in' }, s); break; }
    case 'image': { const c = it.crop, nat = it.nat; let imgStyle; if (c && (c.w < 1 || c.h < 1 || c.x || c.y)) imgStyle = `position:absolute;width:${100 / c.w}%;height:${100 / c.h}%;left:${(-c.x / c.w) * 100}%;top:${(-c.y / c.h) * 100}%;max-width:none;object-fit:fill`; else imgStyle = 'width:100%;height:100%;object-fit:fill';
      void nat; inner = h('div', { class: 'bd-in bd-img' }, h('div', { class: 'bd-imgbox' }, h('img', { src: it.src, alt: it.alt || '', loading: 'lazy', decoding: 'async', draggable: 'false', style: imgStyle })), ...(it.notes || []).map((n, i) => h('div', { class: 'bd-pin', style: `left:${n.x * 100}%;top:${n.y * 100}%`, title: n.text, 'data-act': 'pin', 'data-i': i }, String(i + 1))), it.caption ? h('div', { class: 'bd-cap' }, it.caption) : null); break; }
    case 'file': { const pdf = it.mime === 'application/pdf'; const exp = it.view === 'expanded'; inner = h('div', { class: 'bd-in bd-file' }, h('div', { class: 'bd-chead' }, h('span', { class: 'bd-cic' }, icon(FILE_ICON(it.mime), 20)), h('div', { class: 'bd-fmeta' }, h('b', {}, it.name || 'File'), h('small', {}, `${(it.mime || '').split('/').pop().toUpperCase()} · ${fmtSize(it.size || 0)}`)), h('button', { type: 'button', class: 'bd-open', 'data-act': 'open', 'aria-label': `Open ${it.name || 'file'}` }, icon('download', 14), 'Open')), exp && pdf ? h('iframe', { class: 'bd-pdf', src: `${it.src}${it.src.includes('?') ? '&' : '?'}inline=1#toolbar=0&navpanes=0`, title: `Preview of ${it.name}`, loading: 'lazy' }) : it.preview ? h('pre', { class: 'bd-prev' }, it.preview) : pdf ? h('small', { class: 'bd-dim' }, 'Choose “Expanded” in the inspector to preview this PDF here.') : null); break; }
    case 'link': { let host = ''; try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { /* bad */ } inner = h('div', { class: 'bd-in bd-link' }, it.image && hh > 150 ? h('img', { class: 'bd-limg', src: it.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false', onerror: (e) => e.currentTarget.remove() }) : null, h('div', { class: 'bd-lbody' }, h('div', { class: 'bd-lhost' }, it.favicon ? h('img', { src: it.favicon, alt: '', width: 16, height: 16, loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false', onerror: (e) => e.currentTarget.remove() }) : icon('link', 14), h('small', {}, host), h('button', { type: 'button', class: 'bd-open', 'data-act': 'open', 'aria-label': `Open ${host}` }, 'Open')), h('b', {}, it.title || host || it.url), it.description ? h('p', { class: 'bd-cp' }, it.description) : null)); break; }
    case 'resource': inner = h('div', { class: 'bd-in bd-res' }, cardBody(it, cached(it.ref))); break;
    default: inner = h('div', { class: 'bd-in' }, it.type);
  }
  el.replaceChildren(inner); return el;
}
