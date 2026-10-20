// A tiny PDF writer with no dependencies, used for "Download PDF" buttons. Text only (stats, tables, simple bars) on A4,
// set in the built-in Helvetica fonts, so the file opens anywhere. Runs in the browser; nothing is sent to a server.
const W = 595.28, H = 841.89, M = 40;
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const CP1252 = { '€': 0x80, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85 };
// The built-in fonts have no ₦ or ₵, so write the currency code instead of printing a blank box.
export const clean = (x) => String(x ?? '').replace(/₦/g, 'NGN ').replace(/GH₵/g, 'GHS ').replace(/₵/g, 'GHS ').replace(/→/g, '->').replace(/›/g, '>').replace(/[\r\n\t]+/g, ' ')
  .replace(/[^\x20-\x7e\xa0-\xff€‘’“”•–—…]/g, '?').split('').map((c) => String.fromCharCode(CP1252[c] ?? c.charCodeAt(0))).join('');
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const wOf = (s, size, bold) => { let w = 0; for (const c of s) { const k = c.charCodeAt(0); w += (k >= 32 && k <= 126 ? HW[k - 32] : 556); } return (w / 1000) * size * (bold ? 1.07 : 1); };
const fit = (s, width, size, bold) => { if (wOf(s, size, bold) <= width) return s; let t = s; while (t.length > 1 && wOf(`${t}...`, size, bold) > width) t = t.slice(0, -1); return `${t}...`; };
function wrap(s, width, size, bold) {
  const out = []; let line = '';
  for (const word of s.split(' ')) { const t = line ? `${line} ${word}` : word; if (wOf(t, size, bold) <= width || !line) line = t; else { out.push(line); line = word; } }
  if (line) out.push(line); return out;
}

export function buildPdf({ title, subtitle = '', brand = 'Universe', sections = [], footer = '' }) {
  const pages = []; let ops, y;
  const newPage = () => { ops = []; pages.push(ops); y = H - M; if (pages.length > 1) { text(M, H - 24, clean(title), 8, false, '0.5 0.5 0.5'); y = H - 50; } };
  const text = (x, yy, s, size = 10, bold = false, color = '0 0 0', align = 'l', width = 0) => {
    const dx = align === 'r' ? x + width - wOf(s, size, bold) : x;
    ops.push(`BT ${color} rg /F${bold ? 2 : 1} ${size} Tf ${dx.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const rect = (x, yy, w, h, color) => ops.push(`${color} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const need = (h) => { if (y - h < M + 20) newPage(); };
  newPage();
  rect(0, H - 70, W, 70, '0.93 0.40 0.15'); text(M, H - 34, clean(title), 20, true, '1 1 1'); text(M, H - 54, clean(subtitle || brand), 10, false, '1 0.93 0.88'); y = H - 96;

  for (const s of sections) {
    need(60); text(M, y, clean(s.heading), 13, true, '0.1 0.1 0.1'); y -= 6; rect(M, y, W - 2 * M, 0.7, '0.85 0.85 0.85'); y -= 16;
    if (s.text) for (const line of wrap(clean(s.text), W - 2 * M, 10, false)) { need(14); text(M, y, line, 10, false, '0.25 0.25 0.25'); y -= 14; }
    if (s.stats?.length) {
      const per = Math.min(4, s.stats.length), cw = (W - 2 * M) / per;
      for (let i = 0; i < s.stats.length; i += per) {
        need(46); const row = s.stats.slice(i, i + per);
        row.forEach((st, j) => { const x = M + j * cw; rect(x, y - 34, cw - 8, 40, '0.96 0.96 0.96'); text(x + 8, y - 8, fit(clean(st.label), cw - 24, 8, false), 8, false, '0.45 0.45 0.45'); text(x + 8, y - 26, fit(clean(st.value), cw - 24, 13, true), 13, true, st.tone === 'neg' ? '0.85 0.2 0.25' : st.tone === 'pos' ? '0.1 0.6 0.4' : '0.1 0.1 0.1'); });
        y -= 48;
      }
    }
    if (s.bars?.items?.length) { // grouped bars: items [{label, a, b}], with legend names
      const { items, names = ['', ''] } = s.bars, ch = 110, cw = W - 2 * M, max = Math.max(1, ...items.flatMap((i) => [i.a, i.b])), slot = cw / items.length, bw = Math.min(14, slot / 2.6), step = Math.ceil(items.length / 12);
      need(ch + 40); const base = y - ch;
      rect(M, base, cw, 0.5, '0.7 0.7 0.7'); rect(M + 4, y + 2, 7, 7, '0.24 0.84 0.55'); text(M + 14, y + 2, clean(names[0]), 8, false, '0.4 0.4 0.4'); rect(M + 70, y + 2, 7, 7, '0.93 0.40 0.15'); text(M + 80, y + 2, clean(names[1]), 8, false, '0.4 0.4 0.4');
      items.forEach((it, i) => { const cx = M + slot * i + slot / 2; rect(cx - bw - 1, base, bw, Math.max(it.a ? 1 : 0, (ch - 18) * it.a / max), '0.24 0.84 0.55'); rect(cx + 1, base, bw, Math.max(it.b ? 1 : 0, (ch - 18) * it.b / max), '0.93 0.40 0.15');
        if (i % step === 0) text(cx - 14, base - 11, fit(clean(it.label), 40, 7, false), 7, false, '0.5 0.5 0.5'); });
      y = base - 28;
    }
    if (s.table) {
      const cols = s.table.columns, rows = s.table.rows, tw = W - 2 * M, size = 8.5, num = (c) => /^[-+]?[A-Z]{0,3}\s?[$€£]?[\d,]+(\.\d+)?%?$/.test(String(c).trim());
      const weights = cols.map((c, i) => Math.min(48, Math.max(6, String(c).length, ...rows.slice(0, 60).map((r) => String(r[i] ?? '').length)))), sum = weights.reduce((a, b) => a + b, 0), cw = weights.map((w) => (w / sum) * tw);
      const head = () => { need(40); rect(M, y - 5, tw, 17, '0.94 0.94 0.94'); let x = M; cols.forEach((c, i) => { text(x + 4, y, fit(clean(c), cw[i] - 8, size, true), size, true, '0.2 0.2 0.2', 'l'); x += cw[i]; }); y -= 18; };
      if (!rows.length) { text(M, y, 'Nothing to show.', 9, false, '0.5 0.5 0.5'); y -= 16; } else {
        head();
        rows.forEach((r, ri) => { if (y - 14 < M + 20) { newPage(); head(); } if (ri % 2) rect(M, y - 4, tw, 14, '0.985 0.985 0.985'); let x = M;
          r.forEach((c, i) => { const v = clean(c), right = num(v); text(x + 4, y, fit(v, cw[i] - 8, size, false), size, false, '0.15 0.15 0.15', right ? 'r' : 'l', cw[i] - 8); x += cw[i]; }); y -= 14; });
      }
      y -= 6;
    }
    y -= 12;
  }
  // Assemble the file. Every character is a single byte, so string length equals byte length for the xref offsets.
  const total = pages.length, objs = [], add = (b) => { objs.push(b); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((p, i) => {
    p.push(`BT 0.55 0.55 0.55 rg /F1 8 Tf ${M} 22 Td (${esc(clean(`${footer || brand}  |  Page ${i + 1} of ${total}`))}) Tj ET`);
    const body = p.join('\n'), c = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`), pg = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`);
    kids.push(`${pg} 0 R`);
  });
  objs[1] = `<< /Type /Pages /Count ${total} /Kids [${kids.join(' ')}] >>`;
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return new Blob([bytes], { type: 'application/pdf' });
}

export function downloadPdf(spec, filename) {
  const url = URL.createObjectURL(buildPdf(spec)), a = document.createElement('a');
  a.href = url; a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
