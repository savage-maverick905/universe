// Reads embedded tags in the browser (ID3v2 for MP3, MP4 atoms for M4A/AAC, Vorbis comments + pictures for FLAC).
// Best effort: anything missing is simply left blank and can be typed in by hand. Never throws.
const dec = (b, enc) => { try { return new TextDecoder(enc).decode(b).replace(/\0+$/g, '').replace(/^\uFEFF/, ''); } catch { return ''; } };
const u32 = (d, o) => d.getUint32(o), syncsafe = (d, o) => (d.getUint8(o) << 21) | (d.getUint8(o + 1) << 14) | (d.getUint8(o + 2) << 7) | d.getUint8(o + 3);
const num = (s) => { const m = /^(\d+)/.exec(String(s || '')); return m ? Number(m[1]) : null; };

function id3Text(bytes) {
  const e = bytes[0], body = bytes.subarray(1);
  if (e === 1) return dec(body, body[0] === 0xff && body[1] === 0xfe ? 'utf-16le' : 'utf-16be');
  if (e === 2) return dec(body, 'utf-16be');
  return dec(body, e === 3 ? 'utf-8' : 'iso-8859-1');
}
function readId3(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = {};
  if (buf.length < 10 || dec(buf.subarray(0, 3), 'latin1') !== 'ID3') return out;
  const ver = d.getUint8(3), size = syncsafe(d, 6), end = Math.min(buf.length, 10 + size);
  let o = 10; if (d.getUint8(5) & 0x40) o += ver === 4 ? syncsafe(d, o) : u32(d, o) + 4;
  const map = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist', TRCK: 'track', TPOS: 'disc', TYER: 'year', TDRC: 'date', TCON: 'genre' };
  while (o + 10 <= end) {
    const id = dec(buf.subarray(o, o + 4), 'latin1'); if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ver === 4 ? syncsafe(d, o + 4) : u32(d, o + 4), data = buf.subarray(o + 10, o + 10 + sz); o += 10 + sz;
    if (map[id] && data.length) out[map[id]] = id3Text(data);
    else if (id === 'APIC' && !out.picture) {
      const enc = data[0]; let i = 1; while (data[i] !== 0 && i < data.length) i++; const mime = dec(data.subarray(1, i), 'latin1'); i += 2;
      if (enc === 1 || enc === 2) { while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2; i += 2; } else { while (data[i] !== 0 && i < data.length) i++; i++; }
      out.picture = { mime: /^image\//.test(mime) ? mime : 'image/jpeg', data: data.slice(i) };
    }
  }
  return out;
}
function readFlac(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = {}; let o = 4, last = false;
  if (dec(buf.subarray(0, 4), 'latin1') !== 'fLaC') return out;
  while (!last && o + 4 <= buf.length) {
    const h = d.getUint8(o); last = !!(h & 0x80); const type = h & 0x7f, len = (d.getUint8(o + 1) << 16) | (d.getUint8(o + 2) << 8) | d.getUint8(o + 3); o += 4;
    if (type === 4) { let p = o; const vl = d.getUint32(p, true); p += 4 + vl; const n = d.getUint32(p, true); p += 4;
      for (let i = 0; i < n && p + 4 <= o + len; i++) { const l = d.getUint32(p, true); p += 4; const s = dec(buf.subarray(p, p + l), 'utf-8'); p += l; const k = s.indexOf('='); if (k < 0) continue;
        const key = s.slice(0, k).toLowerCase(), val = s.slice(k + 1); const map = { title: 'title', artist: 'artist', album: 'album', albumartist: 'albumArtist', tracknumber: 'track', discnumber: 'disc', date: 'date', genre: 'genre' }; if (map[key]) out[map[key]] = val; } }
    else if (type === 6 && !out.picture) { let p = o + 4; const ml = d.getUint32(p); const mime = dec(buf.subarray(p + 4, p + 4 + ml), 'latin1'); p += 4 + ml; const dl = d.getUint32(p); p += 4 + dl + 16; const pl = d.getUint32(p); out.picture = { mime, data: buf.slice(p + 4, p + 4 + pl) }; }
    o += len;
  }
  return out;
}
function readMp4(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = {};
  const walk = (from, to, depth) => {
    let o = from;
    while (o + 8 <= to) {
      let size = u32(d, o); const type = dec(buf.subarray(o + 4, o + 8), 'latin1'); let hdr = 8;
      if (size === 1) { size = Number(d.getBigUint64(o + 8)); hdr = 16; } if (size < hdr) break; const end = Math.min(to, o + size);
      if (['moov', 'udta', 'ilst'].includes(type)) walk(o + hdr, end, depth + 1);
      else if (type === 'meta') walk(o + hdr + 4, end, depth + 1);
      else if (depth >= 3 || type === 'trkn' || type === 'disk' || /^(.nam|.ART|.alb|aART|.day|.gen|gnre|covr)$/.test(type) || type === '\u00a9nam') {
        const key = { '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album', aART: 'albumArtist', '\u00a9day': 'date', '\u00a9gen': 'genre', trkn: 'track', disk: 'disc', covr: 'picture' }[type];
        const dd = dec(buf.subarray(o + hdr + 4, o + hdr + 8), 'latin1');
        if (key && dd === 'data') { const flags = d.getUint32(o + hdr + 8) & 0xffffff, body = buf.subarray(o + hdr + 16, end);
          if (key === 'picture') out.picture = { mime: flags === 14 ? 'image/png' : 'image/jpeg', data: body.slice() };
          else if (key === 'track' || key === 'disc') out[key] = String((body[2] << 8) | body[3]); else out[key] = dec(body, 'utf-8'); }
      }
      o = end;
    }
  };
  walk(0, buf.length, 0); return out;
}
export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 6 * 1048576)).arrayBuffer());
    let t = {};
    if (dec(head.subarray(0, 3), 'latin1') === 'ID3') t = readId3(head);
    else if (dec(head.subarray(0, 4), 'latin1') === 'fLaC') t = readFlac(head);
    else if (dec(head.subarray(4, 8), 'latin1') === 'ftyp') { t = readMp4(head); if (!t.title && file.size > head.length) t = { ...t, ...readMp4(new Uint8Array(await file.slice(Math.max(0, file.size - 4 * 1048576)).arrayBuffer())) }; }
    return { title: t.title || '', artists: (t.artist || '').split(/\s*[;\/]\s*|\s+feat\.?\s+|\s*\u0000\s*/i).map((x) => x.trim()).filter(Boolean), album: t.album || '', albumArtist: t.albumArtist || '',
      trackNo: num(t.track), discNo: num(t.disc), year: num(t.date || t.year), genre: (t.genre || '').replace(/^\(\d+\)/, '').trim(), picture: t.picture || null };
  } catch { return { title: '', artists: [], album: '', albumArtist: '', trackNo: null, discNo: null, year: null, genre: '', picture: null }; }
}
// "Artist - Title.mp3" -> fallback guess
export function guessFromName(name) { const base = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim(); const m = /^(.{1,80}?)\s+-\s+(.+)$/.exec(base); return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base }; }
// Duration from the browser's own decoder: the only number that matches what will actually play.
export const audioDuration = (file) => new Promise((res) => { const a = new Audio(), url = URL.createObjectURL(file); const done = (v) => { URL.revokeObjectURL(url); res(v); };
  a.preload = 'metadata'; a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0); a.onerror = () => done(null); setTimeout(() => done(0), 8000); a.src = url; });
// Downscales a cover to <= 800 px JPEG so artwork stays small.
export async function shrinkImage(blob, max = 800) {
  try { const bmp = await createImageBitmap(blob), k = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return await new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.86)); } catch { return null; }
}
