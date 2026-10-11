// A tiny, SAFE markdown renderer for assistant replies. It builds DOM nodes (never innerHTML), so nothing the model writes can run.
// Supports: paragraphs, headings, **bold**, *italic*, `code`, bullet/numbered lists, tables, fenced code, http(s) links.
// Stray HTML the model sometimes writes is converted (<br>, <b>, <i>) or dropped (anything else), never shown as raw tags.

export function cleanHtml(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<(b|strong)>/gi, '**').replace(/<\/(b|strong)>/gi, '**').replace(/<(i|em)>/gi, '*').replace(/<\/(i|em)>/gi, '*')
    .replace(/<\/?[a-z][^>\n]*>/gi, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const INLINE = /\*\*([^*]+?)\*\*|`([^`]+?)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*?)\*/;
export function parseInline(text) {
  const out = []; let rest = text;
  for (let m; (m = INLINE.exec(rest)); rest = rest.slice(m.index + m[0].length)) {
    if (m.index) out.push({ t: 'text', v: rest.slice(0, m.index) });
    if (m[1] !== undefined) out.push({ t: 'b', v: m[1] }); else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'a', v: m[3], href: m[4] }); else out.push({ t: 'i', v: m[5] });
  }
  if (rest) out.push({ t: 'text', v: rest });
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const BULLET = /^\s*[-*•]\s+(.*)/, NUMBER = /^\s*\d+[.)]\s+(.*)/;

export function parseMarkdown(text) {
  const lines = cleanHtml(text).split('\n'), blocks = []; let para = [];
  const flush = () => { if (para.length) blocks.push({ t: 'p', lines: para }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { flush(); continue; }
    if (/^\s*```/.test(l)) { flush(); const code = []; for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]); blocks.push({ t: 'code', text: code.join('\n') }); continue; }
    const hd = /^\s{0,3}(#{1,4})\s+(.*)/.exec(l); if (hd) { flush(); blocks.push({ t: 'h', level: hd[1].length, text: hd[2] }); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { flush(); continue; }
    if (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush(); const head = cells(l), rows = []; i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--; blocks.push({ t: 'table', head, rows }); continue;
    }
    const re = BULLET.test(l) ? BULLET : NUMBER.test(l) ? NUMBER : null;
    if (re) { flush(); const items = [], ordered = re === NUMBER; for (; i < lines.length && re.test(lines[i]); i++) items.push(re.exec(lines[i])[1]); i--; blocks.push({ t: 'list', ordered, items }); continue; }
    para.push(l);
  }
  flush(); return blocks;
}

const num = (s) => /^[₦$€£]?\s?-?[\d,]+(\.\d+)?\s?%?$/.test(s.replace(/\*/g, '').trim());
// `h` is the app's element builder, h(tag, attrs, ...children).
export function renderMarkdown(text, h) {
  const inl = (s) => parseInline(s).map((n) => n.t === 'text' ? n.v : n.t === 'b' ? h('strong', {}, n.v) : n.t === 'i' ? h('em', {}, n.v) : n.t === 'code' ? h('code', {}, n.v) : h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, n.v));
  const withBreaks = (lines) => lines.flatMap((l, i) => (i ? [h('br'), ...inl(l)] : inl(l)));
  return h('div', { class: 'md' }, parseMarkdown(text).map((b) => {
    if (b.t === 'p') return h('p', {}, ...withBreaks(b.lines));
    if (b.t === 'h') return h('p', { class: 'md-h' }, ...inl(b.text));
    if (b.t === 'code') return h('pre', {}, h('code', {}, b.text));
    if (b.t === 'list') return h(b.ordered ? 'ol' : 'ul', {}, b.items.map((x) => h('li', {}, ...inl(x))));
    return h('div', { class: 'md-table' }, h('table', {}, h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, ...inl(c))))),
      h('tbody', {}, b.rows.map((r) => h('tr', {}, b.head.map((_, i) => h('td', { class: num(r[i] || '') ? 'num' : '' }, ...inl(r[i] || ''))))))));
  }));
}
