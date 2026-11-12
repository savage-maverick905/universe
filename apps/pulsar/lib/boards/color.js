// Pure colour helpers: '#rrggbb' or '#rrggbbaa' <-> { hex, a }.
export const parse = (c) => { const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c || ''); return m ? { hex: `#${m[1].toLowerCase()}`, a: m[2] ? parseInt(m[2], 16) / 255 : 1 } : { hex: '#000000', a: c === 'transparent' || c === 'none' ? 0 : 1 }; };
export const join = (hex, a = 1) => (a >= 0.995 ? hex : `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`);
