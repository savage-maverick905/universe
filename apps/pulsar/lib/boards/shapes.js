// Pure shape/default definitions (no DOM) shared by the editor and the exporter.
export const DEFAULTS = { text: { size: 18, color: '#f2f2f2', align: 'left', pad: 8, bw: 0, border: '#a6a6a6', bg: 'transparent', font: 'sans' }, sticky: { size: 16, color: '#1b1b1f', bg: '#fff3a3', align: 'left', pad: 14, font: 'sans' }, shape: { fill: '#1b1b1b', stroke: '#ff6b1a', sw: 2, opacity: 1, color: '#f2f2f2', size: 15, align: 'center', font: 'sans' } };
export function shapePath(kind, w, h) {
  const r = (n) => Math.round(n * 100) / 100;
  switch (kind) { case 'rect': return `M0 0H${r(w)}V${r(h)}H0Z`; case 'rrect': { const k = Math.min(18, w / 4, h / 4); return `M${k} 0H${r(w - k)}Q${r(w)} 0 ${r(w)} ${k}V${r(h - k)}Q${r(w)} ${r(h)} ${r(w - k)} ${r(h)}H${k}Q0 ${r(h)} 0 ${r(h - k)}V${k}Q0 0 ${k} 0Z`; }
    case 'circle': case 'ellipse': { const a = w / 2, b = h / 2; return `M0 ${r(b)}A${r(a)} ${r(b)} 0 1 0 ${r(w)} ${r(b)}A${r(a)} ${r(b)} 0 1 0 0 ${r(b)}Z`; }
    case 'diamond': return `M${r(w / 2)} 0L${r(w)} ${r(h / 2)}L${r(w / 2)} ${r(h)}L0 ${r(h / 2)}Z`; case 'triangle': return `M${r(w / 2)} 0L${r(w)} ${r(h)}L0 ${r(h)}Z`;
    case 'arrow': { const t = h * 0.28, hd = Math.min(w * 0.4, h * 0.9); return `M0 ${r(t)}H${r(w - hd)}V0L${r(w)} ${r(h / 2)}L${r(w - hd)} ${r(h)}V${r(h - t)}H0Z`; }
    case 'line': return `M0 ${r(h)}L${r(w)} 0`; default: return `M0 0H${r(w)}V${r(h)}H0Z`; }
}
