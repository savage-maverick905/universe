import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { startTestApp, closeAll } from './helpers.js';
import { readTags, guessFromName } from '../apps/jupiter/lib/tags.js';
after(closeAll);

const syncsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const frame = (id, body) => Buffer.concat([Buffer.from(id), Buffer.from([0, 0, (body.length >> 8) & 255, body.length & 255]), Buffer.from([0, 0]), body]);
const txt = (s) => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);

test('tag reader: ID3 title/artists/album/track/year/genre and embedded cover; damaged input never throws', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 7)]);
  const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3]), Buffer.from('\0'), png]);
  const frames = Buffer.concat([frame('TIT2', txt('Essence')), frame('TPE1', txt('Wizkid; Tems')), frame('TALB', txt('Made in Lagos')), frame('TPE2', txt('Wizkid')), frame('TRCK', txt('4/12')), frame('TYER', txt('2020')), frame('TCON', txt('Afrobeats')), frame('APIC', apic)]);
  const file = new Blob([Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames, Buffer.alloc(2000, 0xff)])]);
  const t = await readTags(file);
  assert.deepEqual([t.title, t.artists, t.album, t.albumArtist, t.trackNo, t.year, t.genre], ['Essence', ['Wizkid', 'Tems'], 'Made in Lagos', 'Wizkid', 4, 2020, 'Afrobeats']);
  assert.equal(t.picture.mime, 'image/png'); assert.ok(Buffer.from(t.picture.data).equals(png));
  for (const junk of [Buffer.alloc(0), Buffer.from('ID3'), Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(5000), Buffer.alloc(50, 9)]), Buffer.from('fLaC\x00\x00\x00\x30junk'), Buffer.from('....ftypM4A xxxx')]) {
    const r = await readTags(new Blob([junk])); assert.equal(r.title, ''); assert.ok(Array.isArray(r.artists));
  }
});

test('tag reader: FLAC Vorbis comments and MP4 atoms', async () => {
  const comments = ['TITLE=Calm Down', 'ARTIST=Rema', 'ALBUM=Rave & Roses', 'TRACKNUMBER=2', 'DATE=2022-03-25', 'GENRE=Afrobeats'].map((s) => Buffer.from(s));
  const vendor = Buffer.from('test'), le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const body = Buffer.concat([le(vendor.length), vendor, le(comments.length), ...comments.flatMap((c) => [le(c.length), c])]);
  const hdr = Buffer.from([0x84, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]);
  const f = await readTags(new Blob([Buffer.concat([Buffer.from('fLaC'), hdr, body, Buffer.alloc(100)])]));
  assert.deepEqual([f.title, f.artists, f.album, f.trackNo, f.year, f.genre], ['Calm Down', ['Rema'], 'Rave & Roses', 2, 2022, 'Afrobeats']);
  const box = (type, ...kids) => { const c = Buffer.concat(kids); const b = Buffer.alloc(8); b.writeUInt32BE(8 + c.length); b.write(type, 4, 'latin1'); return Buffer.concat([b, c]); };
  const data = (s) => { const d = Buffer.from(s); const h = Buffer.alloc(8); h.writeUInt32BE(1, 0); return box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), d); };
  const nam = box('\u00a9nam', data('Last Last')), art = box('\u00a9ART', data('Burna Boy'));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(8), box('moov', box('udta', box('meta', Buffer.alloc(4), box('ilst', nam, art))))]);
  const m = await readTags(new Blob([mp4]));
  assert.deepEqual([m.title, m.artists], ['Last Last', ['Burna Boy']]);
  assert.deepEqual(guessFromName('Tems - Free Mind.mp3'), { artist: 'Tems', title: 'Free Mind' }); assert.deepEqual(guessFromName('track_01.flac'), { artist: '', title: 'track 01' });
});

test('app files: served once installed, backend code never served, every import and service-worker file exists', async () => {
  const t = await startTestApp(); const admin = await t.login('admin@example.com', 'correct-horse-battery');
  assert.equal((await t.request('GET', '/apps/jupiter/app.js')).status, 404);
  assert.equal((await t.request('POST', '/api/apps/jupiter/install', { cookie: admin.cookie })).status, 200);
  for (const p of ['/apps/jupiter/', '/apps/jupiter/app.js', '/apps/jupiter/lib/player.js', '/apps/jupiter/icons/icon-512.png', '/apps/jupiter/app.webmanifest']) assert.equal((await t.request('GET', p)).status, 200, p);
  for (const p of ['/apps/jupiter/server/media.js', '/apps/jupiter/server/index.js', '/apps/jupiter/manifest.json%00', '/apps/jupiter/../nova/app.js']) assert.notEqual((await t.request('GET', p)).status, 200, p);
  const csp = (await t.request('GET', '/healthz')).headers.get('content-security-policy'); assert.match(csp, /media-src 'self' blob:/); assert.match(csp, /img-src[^;]*blob:/);
  const dir = 'apps/jupiter', seen = new Set(), walk = (f) => {
    if (seen.has(f)) return; seen.add(f); const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)) { const spec = m[1]; const target = spec.startsWith('/') ? join('.', spec) : resolve(dirname(f), spec); assert.ok(existsSync(target), `${f} imports missing ${spec}`); if (target.startsWith(resolve(dir)) || target.startsWith(dir)) walk(target.startsWith('/') ? target : target); }
  };
  walk(join(dir, 'app.js'));
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8'); for (const m of sw.matchAll(/'(\/[^']+)'/g)) if (m[1] !== '/shared/sw-core.js' && m[1].includes('.')) assert.ok(existsSync(join('.', m[1].replace(/^\/shared/, 'shared'))) || existsSync(join('.', m[1])), `sw.js lists missing ${m[1]}`);
  const man = JSON.parse(readFileSync(join(dir, 'app.webmanifest'), 'utf8')); for (const i of man.icons) assert.ok(existsSync(join(dir, i.src)), i.src);
});

test('build: static output has the app but no server code and no manifest.json', () => {
  execFileSync('node', ['scripts/build-static.js'], { stdio: 'pipe' });
  assert.ok(existsSync('dist/apps/jupiter/app.js')); assert.ok(!existsSync('dist/apps/jupiter/server')); assert.ok(!existsSync('dist/apps/jupiter/manifest.json'));
  assert.ok(existsSync('dist/apps/jupiter/icons/icon-192.png'));
  const vj = JSON.parse(readFileSync('vercel.json', 'utf8')); assert.equal(vj.crons[0].path, '/api/apps/jupiter/maintenance/weekly'); assert.match(vj.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value, /media-src 'self' blob:/);
});
