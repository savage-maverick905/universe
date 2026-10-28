// Pulsar PDF writer: dependency-free, runs in the browser and Node. Lays out rich documents (headings, formatted text, lists,
// checklists, quotes, callouts, code, tables, images, image rows, links, bookmarks, contents page, headers and footers).
// Fonts are the 14 built-in PDF fonts (WinAnsi), so characters outside Latin-1/Windows-1252 cannot be drawn: they are
// replaced by "?" and COUNTED in the returned warnings, never dropped silently.
import { htmlToRuns, listNumbers, runsToText } from './inline.js';
const W = 595.28, H = 841.89, MX = 56, MT = 62, MB = 62, CW = W - 2 * MX;
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const CP = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
const FONT = { r: 1, b: 2, i: 3, bi: 4, m: 5 };
const BASE = ['', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Courier'];
export function jpegInfo(u) {
  if (!u || u[0] !== 0xFF || u[1] !== 0xD8) return null; let i = 2;
  while (i + 9 < u.length) { if (u[i] !== 0xFF) { i++; continue; } const m = u[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8], nc: u[i + 9] }; i += 2 + ((u[i + 2] << 8) | u[i + 3]); }
  return null;
}
const hex = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(c || ''); if (!m) return null; const n = parseInt(m[1], 16); return `${((n >> 16) & 255) / 255} ${((n >> 8) & 255) / 255} ${(n & 255) / 255}`; };
const fnt = (r, base = '') => (r.code || base === 'm' ? 'm' : `${r.b || base.includes('b') ? 'b' : ''}${r.i || base.includes('i') ? 'i' : ''}` || 'r');
export function buildPdf(doc) {
  const warnings = [], stats = { bad: 0 };
  const lat = (s) => { let o = ''; for (const ch of String(s)) { const c = ch.codePointAt(0); if (c === 9) o += '    '; else if (c === 160) o += ' '; else if (c >= 32 && c <= 126 || c >= 161 && c <= 255) o += ch; else if (CP[ch]) o += String.fromCharCode(CP[ch]); else if (c === 10) o += ' '; else if (c === 0x2192) o += '->'; else if (c === 0x2713 || c === 0x2714) o += 'v'; else if (c === 0xFE0F || c === 0x200D) { /* emoji joiners: nothing to draw */ } else { o += '?'; stats.bad++; } } return o; };
  const wid = (s, f, size) => { if (f === 'm') return s.length * 0.6 * size; let w = 0; for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); w += c >= 32 && c <= 126 ? HW[c - 32] : 556; } return (w / 1000) * size * (f === 'b' || f === 'bi' ? 1.05 : 1); };
  const pdfEsc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const pages = [], imgs = doc.images || []; let P, y, section = '';
  const newPage = () => { P = { ops: [], annots: [], im: new Set(), sec: section }; pages.push(P); y = H - MT; return P; };
  const need = (h) => { if (y - h < MB) newPage(); };
  const rg = (c) => c || '0.1 0.1 0.12';
  const rect = (x, yy, w, h, fill) => P.ops.push(`${fill} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const stroke = (x, yy, w, h, fill, line) => P.ops.push(`${fill ? `${fill} rg ` : ''}${line} RG 0.5 w ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill ? 'B' : 'S'}`);
  const text = (x, yy, s, f, size, color) => P.ops.push(`BT ${rg(color)} rg /F${FONT[f]} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${pdfEsc(s)}) Tj ET`);
  // Break runs into words and lay them out in lines of at most `width` points.
  function layout(runs, width, size, base = '', color = null) {
    const lines = []; let cur = [], cw = 0; const flush = () => { while (cur.length && !cur[cur.length - 1].s.trim()) cw -= cur.pop().w; lines.push({ parts: cur, w: Math.max(0, cw) }); cur = []; cw = 0; };
    for (const r of runs) {
      const f = fnt(r, base), col = hex(r.color) || (r.href ? '0.1 0.32 0.8' : color), mk = (s) => ({ s, f, col, u: r.u || !!r.href, st: r.s, href: r.href, w: wid(s, f, size), code: r.code });
      for (const piece of lat(r.t.replace(/\n/g, '\u0001')).split(/(\s+|\u0001)/)) {
        if (!piece) continue; if (piece === '\u0001') { flush(); continue; }
        const part = mk(piece);
        if (/^\s+$/.test(piece)) { if (cur.length) { cur.push(part); cw += part.w; } continue; }
        if (cw + part.w > width && cur.length) flush();
        if (part.w > width) { let chunk = ''; for (const ch of piece) { if (wid(chunk + ch, f, size) > width && chunk) { const p = mk(chunk); cur.push(p); cw += p.w; flush(); chunk = ''; } chunk += ch; } if (chunk) { const p = mk(chunk); cur.push(p); cw += p.w; } continue; }
        cur.push(part); cw += part.w;
      }
    }
    if (cur.length || !lines.length) flush();
    return lines;
  }
  function drawLine(line, x, base, size, align = 'l', maxW = CW) {
    let cx = align === 'c' ? x + (maxW - line.w) / 2 : align === 'r' ? x + maxW - line.w : x;
    for (const p of line.parts) {
      if (p.s.trim()) { if (p.code) rect(cx - 1, base - size * 0.25, p.w + 2, size * 1.1, '0.94 0.94 0.95'); text(cx, base, p.s, p.f, size, p.col); }
      if (p.u && p.s.trim()) rect(cx, base - 1.6, p.w, 0.6, rg(p.col)); if (p.st && p.s.trim()) rect(cx, base + size * 0.3, p.w, 0.6, rg(p.col));
      if (p.href && /^(https?:|mailto:)/i.test(p.href)) P.annots.push({ x: cx, y: base - 2, w: p.w, h: size + 2, href: p.href });
      cx += p.w;
    }
  }
  function para(runs, { size = 10.5, x = MX, w = CW, base = '', color = null, lead = 1.5, after = 5, align = 'l', before = 0, keep = 0 } = {}) {
    const lines = layout(runs, w, size, base, color), lh = size * lead; y -= before;
    if (keep) need(lh + keep);
    if (!runs.length || !lines.length) { need(lh * 0.8); y -= lh * 0.8; return; }
    for (const l of lines) { need(lh); drawLine(l, x, y - size, size, align, w); y -= lh; }
    y -= after;
  }
  function box(lines, { size = 10, lh = size * 1.45, x = MX, w = CW, pad = 7, bg, bar, barW = 3, textX = 0, align = 'l', after = 7 }) {
    let i = 0;
    while (i < lines.length) {
      need(lh + 2 * pad); const n = Math.max(1, Math.min(lines.length - i, Math.floor((y - MB - 2 * pad) / lh))), h = n * lh + 2 * pad;
      if (bg) rect(x, y - h, w, h, bg); if (bar) rect(x, y - h, barW, h, bar);
      for (let k = 0; k < n; k++) drawLine(lines[i + k], x + pad + textX, y - pad - k * lh - size, size, align, w - 2 * pad - textX);
      y -= h; i += n;
    }
    y -= after;
  }
  const num = (blocks) => listNumbers(blocks);
  function image(b) {
    const caps = b.caption?.length ? layout(b.caption, CW, 9, 'i', '0.4 0.4 0.45') : [], capH = caps.length * 12.5;
    const im = b.img;
    if (!im) { warnings.push(`Image could not be included: ${b.alt || b.src || 'unknown image'}`); box(layout([{ t: `[Image unavailable: ${b.alt || b.name || 'image'}]` }], CW - 20, 9, 'i', '0.5 0.2 0.2'), { size: 9, bg: '0.98 0.94 0.94', bar: '0.85 0.3 0.3' }); return; }
    let wpt = Math.min(CW, CW * ((b.w || 100) / 100)); wpt = Math.min(wpt, im.w * 0.75 * 1.4 > CW ? wpt : im.w * 0.75 * 1.4); let hpt = wpt * im.h / im.w; const maxH = H - MT - MB - capH - 20;
    if (hpt > maxH) { hpt = maxH; wpt = hpt * im.w / im.h; }
    need(hpt + capH + 10); const x = b.align === 'center' ? MX + (CW - wpt) / 2 : b.align === 'right' ? MX + CW - wpt : MX;
    P.ops.push(`q ${wpt.toFixed(2)} 0 0 ${hpt.toFixed(2)} ${x.toFixed(2)} ${(y - hpt).toFixed(2)} cm /Im${im.n} Do Q`); P.im.add(im.n); y -= hpt + 4;
    for (const l of caps) { drawLine(l, MX, y - 9, 9, 'c'); y -= 12.5; } y -= 8;
  }
  function gallery(b) {
    const list = b.imgs || []; if (!list.length) return; const gap = 8, each = (CW - gap * (list.length - 1)) / list.length;
    const sizes = list.map((g) => (g.img ? { w: each, h: each * g.img.h / g.img.w } : { w: each, h: 40 }));
    let rowH = Math.max(...sizes.map((s) => s.h)); const maxH = H - MT - MB - 60; if (rowH > maxH) { const k = maxH / rowH; sizes.forEach((s) => { s.w *= k; s.h *= k; }); rowH = maxH; }
    const caps = b.caption?.length ? layout(b.caption, CW, 9, 'i', '0.4 0.4 0.45') : []; need(rowH + caps.length * 12.5 + 10);
    let x = MX + (CW - sizes.reduce((a, s) => a + s.w, 0) - gap * (list.length - 1)) / 2;
    list.forEach((g, k) => { if (g.img) { P.ops.push(`q ${sizes[k].w.toFixed(2)} 0 0 ${sizes[k].h.toFixed(2)} ${x.toFixed(2)} ${(y - sizes[k].h).toFixed(2)} cm /Im${g.img.n} Do Q`); P.im.add(g.img.n); } else { warnings.push(`Image could not be included: ${g.alt || g.src}`); stroke(x, y - 40, sizes[k].w, 40, '0.98 0.94 0.94', '0.8 0.4 0.4'); } x += sizes[k].w + gap; });
    y -= rowH + 4; for (const l of caps) { drawLine(l, MX, y - 9, 9, 'c'); y -= 12.5; } y -= 8;
  }
  function table(b) {
    const rows = (b.rows || []).map((r) => r.map((c) => htmlToRuns(c))); if (!rows.length) return; const n = Math.max(...rows.map((r) => r.length));
    const wt = Array.from({ length: n }, (_, c) => Math.min(40, Math.max(8, ...rows.map((r) => runsToText(r[c] || []).length)))), tot = wt.reduce((a, c) => a + c, 0), cw = wt.map((x) => (x / tot) * CW), size = 9.5, lh = size * 1.4, pad = 4;
    rows.forEach((r, ri) => {
      const head = ri === 0 && b.header !== false, cells = Array.from({ length: n }, (_, c) => layout(r[c] || [], cw[c] - 2 * pad, size, head ? 'b' : '')); let done = 0; const total = Math.max(1, ...cells.map((c) => c.length));
      while (done < total) {
        need(lh + 2 * pad); const cnt = Math.max(1, Math.min(total - done, Math.floor((y - MB - 2 * pad) / lh))), h = cnt * lh + 2 * pad; let x = MX;
        cells.forEach((lines, c) => { stroke(x, y - h, cw[c], h, head ? '0.93 0.94 0.96' : null, '0.75 0.76 0.8'); lines.slice(done, done + cnt).forEach((l, k) => drawLine(l, x + pad, y - pad - k * lh - size, size, 'l', cw[c] - 2 * pad)); x += cw[c]; });
        y -= h; done += cnt;
      }
    });
    y -= 10;
  }
  function block(b, nums) {
    const runs = () => htmlToRuns(b.html || ''), ind = (b.indent || 0) * 18;
    switch (b.type) {
      case 'h1': para(runs(), { size: 20, base: 'b', before: 10, after: 6, lead: 1.3, keep: 50 }); break;
      case 'h2': para(runs(), { size: 15.5, base: 'b', before: 8, after: 5, lead: 1.3, keep: 45 }); break;
      case 'h3': para(runs(), { size: 12.5, base: 'b', before: 6, after: 4, lead: 1.3, keep: 40 }); break;
      case 'ul': need(16); text(MX + ind + 4, y - 10.5, '\x95', 'r', 10.5, '0.3 0.3 0.35'); para(runs(), { x: MX + ind + 18, w: CW - ind - 18, after: 2 }); break;
      case 'ol': need(16); text(MX + ind, y - 10.5, `${nums[b.id] || 1}.`, 'r', 10.5, '0.3 0.3 0.35'); para(runs(), { x: MX + ind + 18, w: CW - ind - 18, after: 2 }); break;
      case 'todo': need(16); stroke(MX + ind + 1, y - 11, 9, 9, null, '0.4 0.4 0.45'); if (b.checked) P.ops.push(`0.1 0.55 0.3 RG 1.4 w ${MX + ind + 3} ${y - 7} m ${MX + ind + 5} ${y - 9.5} l ${MX + ind + 9.5} ${y - 3.5} l S`); para(runs().map((r) => (b.checked ? { ...r, s: true, color: r.color || '#888888' } : r)), { x: MX + ind + 18, w: CW - ind - 18, after: 2 }); break;
      case 'quote': box(layout(runs(), CW - 24, 10.5, 'i', '0.3 0.3 0.35'), { size: 10.5, bar: '0.75 0.75 0.8', pad: 6, textX: 8 }); break;
      case 'callout': box(layout(runs(), CW - 26, 10.5, '', '0.12 0.12 0.15'), { size: 10.5, bg: '0.96 0.95 0.9', bar: '0.93 0.55 0.2', pad: 9, textX: 4 }); break;
      case 'code': box(layout([{ t: runsToText(runs()) }], CW - 20, 8.5, 'm', '0.15 0.15 0.2').flatMap((l) => [l]), { size: 8.5, lh: 12, bg: '0.95 0.95 0.96', pad: 8 }); break;
      case 'hr': need(18); rect(MX, y - 8, CW, 0.7, '0.8 0.8 0.84'); y -= 18; break;
      case 'table': table(b); break;
      case 'image': image(b); break;
      case 'gallery': gallery(b); break;
      case 'pagelink': para([{ t: `-> ${b.title || 'Linked page'}`, color: '#1a52cc', u: true }], { size: 10.5 }); break;
      case 'file': para([{ t: `Attachment: ${b.name || 'file'}${b.size ? ` (${Math.max(1, Math.round(b.size / 1024))} KB)` : ''}`, i: true }], { size: 10, color: '0.35 0.35 0.4' }); break;
      case 'toc': break;
      default: para(runs(), { size: 10.5, after: 5 });
    }
  }
  // ---- document structure: items = [{ title, level, icon?, blocks, subtitle? }] ----
  const items = doc.items || [], withToc = doc.toc && items.length > 1;
  const tocPages = withToc ? Math.ceil((items.length + 4) / 38) : 0;
  if (withToc) for (let k = 0; k < tocPages; k++) newPage();
  const itemPages = [];
  items.forEach((it, idx) => {
    section = it.title; if (idx > 0 || withToc) newPage(); else if (!P) newPage(); else P.sec = section;
    if (!withToc && idx === 0) P.sec = section;
    itemPages.push({ title: it.title, level: it.level || 0, page: pages.length - 1, y });
    const size = [24, 19, 16, 14][Math.min(it.level || 0, 3)];
    para([{ t: it.title || 'Untitled' }], { size, base: 'b', lead: 1.25, after: 4 });
    if (it.subtitle) para([{ t: it.subtitle }], { size: 9, color: '0.5 0.5 0.55', after: 4 });
    rect(MX, y - 2, CW, 0.8, '0.85 0.85 0.88'); y -= 14;
    const nums = num(it.blocks || []); if (!it.blocks?.length) para([{ t: 'This page is empty.', i: true }], { size: 10, color: '0.55 0.55 0.6' });
    for (const b of it.blocks || []) { try { block(b, nums); } catch (e) { warnings.push(`A block (${b.type}) in "${it.title}" could not be drawn: ${e.message}`); } }
  });
  if (!pages.length) newPage();
  if (withToc) {
    let k = 0, line = 0; const per = 38; P = pages[0]; y = H - MT;
    const cover = (doc.title || 'Export'); para([{ t: cover }], { size: 26, base: 'b', lead: 1.2, after: 4 }); para([{ t: doc.subtitle || `${items.length} pages` }], { size: 10, color: '0.5 0.5 0.55', after: 12 }); para([{ t: 'Contents' }], { size: 14, base: 'b', after: 8 });
    for (const it of itemPages) {
      if (y - 18 < MB) { k++; P = pages[k]; y = H - MT; }
      const label = lat(it.title || 'Untitled'); let t = label; const x = MX + it.level * 14, maxW = CW - it.level * 14 - 40; while (t.length > 1 && wid(t, it.level ? 'r' : 'b', 10.5) > maxW) t = t.slice(0, -1); if (t !== label) t += '...';
      text(x, y - 10, t, it.level ? 'r' : 'b', 10.5, null); const pn = String(it.page + 1); text(MX + CW - wid(pn, 'r', 10.5), y - 10, pn, 'r', 10.5, '0.4 0.4 0.45'); it.tocPage = k; it.tocY = y;
      P.annots.push({ x, y: y - 12, w: CW - it.level * 14, h: 15, dest: it.page, destY: it.y }); y -= 18; line++;
    }
  }
  // ---- assemble ----
  const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const objs = []; const add = (...parts) => objs.push(parts); const ref = (n) => `${n} 0 R`;
  add('<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageMode /UseOutlines >>'); add(''); for (let f = 1; f <= 5; f++) add(`<< /Type /Font /Subtype /Type1 /BaseFont /${BASE[f]} /Encoding /WinAnsiEncoding >>`); // 3..7
  add(''); // 8: outlines root, filled in below
  const imgObjStart = objs.length + 1; imgs.forEach((im) => add(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.nc === 1 ? '/DeviceGray' : im.nc === 4 ? '/DeviceCMYK' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode${im.nc === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${im.data.length} >>\nstream\n`, im.data, '\nendstream'));
  const total = pages.length, pageObjIdx = [];
  const pageObjNum = (i) => pageObjIdx[i];
  // reserve page object numbers first (contents, annots follow)
  let nextNum = objs.length + 1; pages.forEach((p, i) => { pageObjIdx[i] = nextNum; nextNum += 2 + p.annots.length; });
  const outlineBase = nextNum;
  pages.forEach((p, i) => {
    const body = []; const save = P; P = { ops: body };
    if (i >= 1 && !(withToc && i < tocPages)) text(MX, H - 34, lat(p.sec || ''), 'r', 8, '0.55 0.55 0.6');
    text(MX, 28, lat(doc.footer || doc.title || '').slice(0, 80), 'r', 8, '0.55 0.55 0.6'); const pn = `Page ${i + 1} of ${total}`; text(W - MX - wid(pn, 'r', 8), 28, pn, 'r', 8, '0.55 0.55 0.6'); P = save;
    const content = enc(`${p.ops.join('\n')}\n${body.join('\n')}`), base = pageObjIdx[i];
    const res = `<< /Font << ${[1, 2, 3, 4, 5].map((f) => `/F${f} ${2 + f} 0 R`).join(' ')} >>${p.im.size ? ` /XObject << ${[...p.im].map((n) => `/Im${n} ${imgObjStart + n - 1} 0 R`).join(' ')} >>` : ''} >>`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources ${res} /Contents ${ref(base + 1)}${p.annots.length ? ` /Annots [${p.annots.map((_, k) => ref(base + 2 + k)).join(' ')}]` : ''} >>`);
    add(`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
    for (const a of p.annots) {
      const r = `[${a.x.toFixed(2)} ${a.y.toFixed(2)} ${(a.x + a.w).toFixed(2)} ${(a.y + a.h).toFixed(2)}]`;
      add(a.dest !== undefined ? `<< /Type /Annot /Subtype /Link /Rect ${r} /Border [0 0 0] /Dest [${ref(pageObjIdx[a.dest])} /XYZ 0 ${(a.destY + 20).toFixed(1)} 0] >>` : `<< /Type /Annot /Subtype /Link /Rect ${r} /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(encodeURI(a.href).replace(/[^\x20-\x7e]/g, ''))}) >> >>`);
    }
  });
  objs[1] = [`<< /Type /Pages /Count ${total} /Kids [${pages.map((_, i) => ref(pageObjIdx[i])).join(' ')}] >>`];
  // outline (bookmarks) mirroring the page hierarchy
  const nodes = itemPages.map((it, k) => ({ ...it, k, num: outlineBase + k, kids: [], parent: null })), stack = [];
  for (const n of nodes) { while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop(); n.parent = stack[stack.length - 1] || null; (n.parent ? n.parent.kids : (stack.root ||= [])).push(n); stack.push(n); }
  const roots = nodes.filter((n) => !n.parent);
  objs[7] = [roots.length ? `<< /Type /Outlines /First ${ref(roots[0].num)} /Last ${ref(roots[roots.length - 1].num)} /Count ${nodes.length} >>` : '<< /Type /Outlines /Count 0 >>'];
  for (const n of nodes) {
    const sibs = n.parent ? n.parent.kids : roots, i = sibs.indexOf(n);
    add(`<< /Title (${pdfEsc(lat(n.title || 'Untitled'))}) /Parent ${n.parent ? ref(n.parent.num) : '8 0 R'} /Dest [${ref(pageObjIdx[n.page])} /XYZ 0 ${(n.y + 20).toFixed(1)} 0]${i > 0 ? ` /Prev ${ref(sibs[i - 1].num)}` : ''}${i < sibs.length - 1 ? ` /Next ${ref(sibs[i + 1].num)}` : ''}${n.kids.length ? ` /First ${ref(n.kids[0].num)} /Last ${ref(n.kids[n.kids.length - 1].num)} /Count ${n.kids.length}` : ''} >>`);
  }
  const info = objs.length + 1; add(`<< /Title (${pdfEsc(lat(doc.title || 'Pulsar export'))}) /Producer (Pulsar) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  const chunks = []; let len = 0; const put = (u) => { chunks.push(u); len += u.length; }; const offs = [];
  put(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  objs.forEach((parts, i) => { offs.push(len); put(enc(`${i + 1} 0 obj\n`)); for (const p of parts) put(typeof p === 'string' ? enc(p) : p); put(enc('\nendobj\n')); });
  const xr = len; put(enc(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xr}\n%%EOF\n`));
  const out = new Uint8Array(len); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  if (stats.bad) warnings.push(`${stats.bad} character(s) outside the PDF's built-in Latin character set (for example emoji or non-Latin scripts) were replaced with "?". Use Markdown or JSON export to keep them exactly.`);
  return { bytes: out, pages: total, warnings };
}
// Register decoded JPEG bytes so blocks can reference them: returns { n, w, h, nc, data } or null.
export function makeImageRegistry() {
  const list = [], map = new Map();
  return { list, add(key, data) { if (map.has(key)) return map.get(key); const inf = jpegInfo(data); if (!inf) return null; const im = { n: list.length + 1, ...inf, data }; list.push(im); map.set(key, im); return im; } };
}
