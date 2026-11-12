// Board rich text: a small sanitised HTML subset shared by the browser and the server. No DOM needed.
// Allowed: b i u s br div p ul ol li. Everything else is dropped (its text is kept); no attributes survive.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const dec = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } } return ENT[e.toLowerCase()] ?? m; });
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const OK = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', br: 'br', div: 'div', p: 'p', ul: 'ul', ol: 'ol', li: 'li' };
export function sanitizeRich(html = '') {
  const re = /<(\/?)([a-z0-9]+)(?:\s[^>]*)?>|([^<]+)|</gi, st = []; let out = '', m;
  const src = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '');
  while ((m = re.exec(src))) {
    if (m[3] !== undefined) { out += esc(dec(m[3])); continue; } if (!m[2]) { out += '&lt;'; continue; }
    const tag = OK[m[2].toLowerCase()]; if (!tag) continue;
    if (tag === 'br') { if (!m[1]) out += '<br>'; continue; }
    if (m[1]) { const k = st.lastIndexOf(tag); if (k >= 0) { while (st.length > k) out += `</${st.pop()}>`; } continue; }
    st.push(tag); out += `<${tag}>`;
  }
  while (st.length) out += `</${st.pop()}>`; return out;
}
export function richToText(html = '') { return dec(String(html).replace(/<\/(div|p|li)>|<br\s*\/?>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim(); }
export const toRich = (text = '') => esc(text).replace(/\n/g, '<br>');
