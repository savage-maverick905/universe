// Online artwork: search covers (iTunes Search, no key) and fetch an image from a link the user pastes.
// Everything goes through the server so the browser's CSP stays strict. Fetching a user-supplied URL is an SSRF risk,
// so: https only, no credentials, public IPs only (checked on every redirect), 5 MB cap, 10 s timeout, and the bytes
// must actually be an image (magic bytes), never trusted by Content-Type.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { badRequest } from '../../../shared/errors.js';

const MAX = 5 * 1024 * 1024, HTML_MAX = 600 * 1024;
const privateIp = (ip) => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  const l = ip.toLowerCase(); if (l.startsWith('::ffff:')) return privateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
};
async function safeUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { throw badRequest('That does not look like a web link.'); }
  if (u.protocol !== 'https:') throw badRequest('Only https:// links work.');
  if (u.username || u.password) throw badRequest('Links with a login in them are not allowed.');
  if (u.port && u.port !== '443') throw badRequest('That link uses an unusual port.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) ? privateIp(host) : false) throw badRequest('That address is not allowed.');
  if (!net.isIP(host)) { let addrs; try { addrs = await lookup(host, { all: true }); } catch { throw badRequest('Could not find that website.'); } if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw badRequest('That address is not allowed.'); }
  return u;
}
async function readCapped(res, cap) {
  const chunks = []; let n = 0;
  for await (const c of res.body) { n += c.length; if (n > cap) throw badRequest('That file is too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function get(url, accept) {
  let u = await safeUrl(url);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (compatible; Jupiter/1.0)' } }).catch(() => { throw badRequest('Could not reach that link.'); });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = await safeUrl(new URL(res.headers.get('location'), u).href); continue; }
    if (!res.ok) throw badRequest(`That link answered with an error (${res.status}).`);
    return { res, url: u };
  }
  throw badRequest('That link redirects too many times.');
}
const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : b.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : null);

export async function fetchImage(link) {
  let { res, url } = await get(link, 'image/*,text/html;q=0.8');
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) { // a web page: use its preview image
    const html = (await readCapped(res, HTML_MAX).catch(() => Buffer.alloc(0))).toString('utf8');
    const m = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(html);
    if (!m) throw badRequest('That page has no picture I can use. Long-press the picture itself and choose “Copy image address”.');
    ({ res } = await get(new URL(m[1].replace(/&amp;/g, '&'), url).href, 'image/*'));
  }
  const buf = await readCapped(res, MAX), mime = sniff(buf);
  if (!mime) throw badRequest('That link is not a JPEG, PNG, WebP or GIF image.');
  return { buf, mime };
}

export async function searchArt(q) {
  const term = String(q || '').trim().slice(0, 120); if (term.length < 2) throw badRequest('Type at least 2 letters to search.');
  const res = await fetch(`https://itunes.apple.com/search?media=music&entity=album&limit=24&term=${encodeURIComponent(term)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => { throw badRequest('Online search is not reachable right now.'); });
  if (!res.ok) throw badRequest('Online search is not reachable right now.');
  const data = await res.json().catch(() => ({ results: [] }));
  return { results: (data.results || []).filter((r) => r.artworkUrl100).map((r) => ({ title: String(r.collectionName || '').slice(0, 120), artist: String(r.artistName || '').slice(0, 120), thumb: r.artworkUrl100.replace('100x100bb', '200x200bb'), full: r.artworkUrl100.replace('100x100bb', '800x800bb') })) };
}
