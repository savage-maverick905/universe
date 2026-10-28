// Pulsar text helpers shared by the browser and the server (no DOM needed, so they are testable in Node).
// Inline text is stored as a SMALL, SANITISED subset of HTML: b i u s code a span[color] br.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
  return ENT[e.toLowerCase()] ?? m;
});
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_HREF = /^(https?:|mailto:|tel:|#\/)/i;
export const safeHref = (h) => { const x = String(h || '').trim(); return SAFE_HREF.test(x) ? x : ''; };
const COLOR = /^#[0-9a-f]{6}$/i;
function parseColor(style = '') {
  const m = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style); if (!m) return '';
  const c = m[1].trim(), rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
  if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
  return COLOR.test(c) ? c.toLowerCase() : '';
}
// HTML -> runs [{t, b, i, u, s, code, href, color}]
export function htmlToRuns(html = '') {
  const out = [], st = []; const cur = () => st.reduce((a, f) => ({ ...a, ...f.fx }), {});
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)|</gi; let m;
  const push = (t) => { if (!t) return; const f = cur(), last = out[out.length - 1]; const r = { t, ...f };
    if (last && ['b', 'i', 'u', 's', 'code', 'href', 'color'].every((k) => (last[k] || false) === (r[k] || false))) last.t += t; else out.push(r); };
  while ((m = re.exec(String(html)))) {
    if (m[4] !== undefined) { push(decode(m[4])); continue; }
    if (!m[2]) { push('<'); continue; }
    const tag = m[2].toLowerCase(), close = m[1] === '/', attrs = m[3] || '';
    if (tag === 'br') { if (!close) push('\n'); continue; }
    if (close) { for (let k = st.length - 1; k >= 0; k--) if (st[k].tag === tag) { st.splice(k, 1); break; } continue; }
    if (/\/\s*$/.test(attrs)) continue;
    let fx = null;
    if (tag === 'b' || tag === 'strong') fx = { b: true };
    else if (tag === 'i' || tag === 'em') fx = { i: true };
    else if (tag === 'u') fx = { u: true };
    else if (tag === 's' || tag === 'strike' || tag === 'del') fx = { s: true };
    else if (tag === 'code') fx = { code: true };
    else if (tag === 'a') { const h = /href\s*=\s*"([^"]*)"/i.exec(attrs) || /href\s*=\s*'([^']*)'/i.exec(attrs); const href = safeHref(h ? decode(h[1]) : ''); fx = href ? { href } : {}; }
    else if (tag === 'span' || tag === 'font') { const sm = /style\s*=\s*"([^"]*)"/i.exec(attrs), cm = /color\s*=\s*"([^"]*)"/i.exec(attrs); const c = parseColor(sm ? decode(sm[1]) : '') || (cm && COLOR.test(cm[1]) ? cm[1].toLowerCase() : ''); fx = c ? { color: c } : {}; }
    else if (tag === 'div' || tag === 'p') { if (out.length && !String(out[out.length - 1].t).endsWith('\n')) push('\n'); fx = {}; }
    else fx = {};
    st.push({ tag, fx });
  }
  return out.filter((r) => r.t !== '');
}
export function runsToHtml(runs) {
  return runs.map((r) => {
    let s = esc(r.t).replace(/\n/g, '<br>');
    if (r.code) s = `<code>${s}</code>`; if (r.b) s = `<b>${s}</b>`; if (r.i) s = `<i>${s}</i>`; if (r.u) s = `<u>${s}</u>`; if (r.s) s = `<s>${s}</s>`;
    if (r.color) s = `<span style="color:${r.color}">${s}</span>`;
    if (r.href) s = `<a href="${esc(r.href)}">${s}</a>`;
    return s;
  }).join('');
}
export const sanitizeHtml = (html) => runsToHtml(htmlToRuns(html));
export const runsToText = (runs) => runs.map((r) => r.t).join('');
export const htmlToText = (html) => runsToText(htmlToRuns(html));
export const runsToMd = (runs) => runs.map((r) => {
  const lead = /^\s*/.exec(r.t)[0], trail = /\s*$/.exec(r.t)[0], core = r.t.trim(); if (!core) return r.t;
  let s = core.replace(/([\\*_`\[\]])/g, '\\$1').replace(/\n/g, '  \n');
  if (r.code) s = '`' + core.replace(/`/g, "'") + '`'; if (r.b) s = `**${s}**`; if (r.i) s = `*${s}*`; if (r.s) s = `~~${s}~~`; if (r.u) s = `<u>${s}</u>`;
  if (r.href) s = `[${s}](${r.href})`;
  return lead + s + trail;
}).join('');
// Numbering for consecutive ordered-list blocks (per indent level).
export function listNumbers(blocks) {
  const out = {}, ctr = [];
  for (const b of blocks) {
    if (b.type !== 'ol') { ctr.length = 0; continue; }
    const d = b.indent || 0; ctr.length = d + 1; ctr[d] = (ctr[d] || 0) + 1; out[b.id] = ctr[d];
  }
  return out;
}
export function blockText(b) {
  switch (b.type) {
    case 'table': return (b.rows || []).map((r) => r.map(htmlToText).join(' ')).join(' ');
    case 'image': return [htmlToText(b.caption || ''), b.alt || ''].join(' ');
    case 'gallery': return [htmlToText(b.caption || ''), ...(b.imgs || []).map((i) => i.alt || '')].join(' ');
    case 'file': return b.name || '';
    case 'hr': case 'toc': case 'pagelink': return '';
    default: return htmlToText(b.html || '');
  }
}
export const blocksPlain = (blocks, max = 200000) => blocks.map(blockText).filter(Boolean).join('\n').slice(0, max);
export const blockLinks = (blocks) => {
  const ids = new Set();
  for (const b of blocks) { if (b.type === 'pagelink' && b.pageId) ids.add(b.pageId); const htmls = b.type === 'table' ? (b.rows || []).flat() : [b.html || '']; for (const h of htmls) for (const m of String(h).matchAll(/href="#\/p\/([A-Za-z0-9_-]+)"/g)) ids.add(m[1]); }
  return [...ids];
};
