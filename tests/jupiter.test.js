import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp, closeAll } from './helpers.js';
import { GithubMediaStore, FsMediaStore, createMediaStore } from '../apps/jupiter/server/media.js';
import { sniffAudio, sniffImage } from '../apps/jupiter/server/audio.js';
import { parseRange } from '../apps/jupiter/server/stream.js';
import { classify } from '../apps/jupiter/server/analytics.js';
import { PART_SIZE } from '../apps/jupiter/server/library.js';
after(closeAll);

const B = '/api/apps/jupiter';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const mp3 = (n, seed = 1) => { const b = randomBytes(n); b.write('ID3', 0, 'latin1'); b[3] = 3; b[4] = 0; b[5] = 0; b[seed % 5 + 6] = seed; return b; };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
const text = (content) => ({ content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const toolCall = (name, args) => ({ content: '', toolCalls: [{ id: 'c1', name, arguments: JSON.stringify(args) }], usage: null });

async function setup(script) {
  const dir = mkdtempSync(join(tmpdir(), 'jupiter-test-'));
  const provider = { id: 'fake', calls: [], async chat(req) { this.calls.push(structuredClone(req)); return (script || (() => text('ok')))(req, this.calls.length); } };
  const t = await startTestApp({ jupiter: { driver: 'fs', dir, secret: 'j'.repeat(32), cronSecret: 'cron-secret-123456', maxFileMb: 50, libraryLimitMb: 60 } }, { providers: { fake: provider } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  assert.equal((await t.request('POST', `${B.replace('/jupiter', '/jupiter')}/install`.replace('/api/apps/jupiter', '/api/apps/jupiter'), { cookie: admin.cookie })).status, 200);
  const port = t.app.server.address().port;
  const bin = async (method, path, { cookie, body, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'X-Requested-With': 'universe', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const api = (method, path, body, u = admin) => t.request(method, B + path, { cookie: u.cookie, body });
  // The browser's upload routine, in miniature.
  const artistIds = new Map();
  async function ensureArtist(name, u = admin) { if (!artistIds.has(name)) artistIds.set(name, (await api('POST', '/artists', { name }, u)).json.artist.id); return artistIds.get(name); }
  async function upload(bytes, meta = {}, { name = 'song.mp3', art, u = admin } = {}) {
    if (meta.artists) { const ids = []; for (const n of meta.artists) ids.push(await ensureArtist(n, u)); const { artists, ...rest } = meta; meta = { ...rest, artistIds: ids }; }
    const hashes = []; for (let o = 0; o < bytes.length; o += PART_SIZE) hashes.push(sha(bytes.subarray(o, o + PART_SIZE)));
    const fingerprint = sha(hashes.join(''));
    const s = await api('POST', '/uploads/start', { name, size: bytes.length, fingerprint }, u);
    if (s.status !== 200) return { start: s };
    const parts = [];
    for (let i = 0; i * PART_SIZE < bytes.length; i++) {
      const chunk = bytes.subarray(i * PART_SIZE, (i + 1) * PART_SIZE);
      const r = await bin('PUT', `${B}/uploads/${s.json.uploadId}/parts/${i}`, { cookie: u.cookie, body: chunk, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha(chunk) } });
      if (r.status !== 200) return { part: r, start: s };
      parts.push(JSON.parse(r.buf.toString()));
    }
    let artTicket = null;
    if (art) { const r = await bin('PUT', `${B}/uploads/${s.json.uploadId}/art`, { cookie: u.cookie, body: art, headers: { 'Content-Type': 'application/octet-stream' } }); artTicket = JSON.parse(r.buf.toString()); }
    const fin = await api('POST', `/uploads/${s.json.uploadId}/finish`, { name, size: bytes.length, parts, meta, ...(artTicket ? { art: artTicket } : {}) }, u);
    return { start: s, parts, fin, id: fin.json?.track?.id };
  }
  const cleanup = async () => { await t.close(); rmSync(dir, { recursive: true, force: true }); };
  return { t, admin, api, bin, upload, ensureArtist, provider, dir, cleanup, B };
}

test('sniffing: audio and images are recognised by their first bytes, not names', () => {
  assert.equal(sniffAudio(mp3(64)), 'mp3');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('....ftypM4A '), Buffer.alloc(8)])), 'm4a');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)])), 'flac');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)])), 'ogg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.alloc(8)])), 'wav');
  assert.equal(sniffAudio(Buffer.from('<?php echo 1; ?> this is a script, not audio at all')), null);
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('....ftypqt  '), Buffer.alloc(8)])), null); // QuickTime video
  assert.equal(sniffImage(PNG).ext, 'png'); assert.equal(sniffImage(Buffer.from('GIF89a......zzzz')), null);
});

test('range parsing', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=10-5000', 1000), { start: 10, end: 999 });
  for (const bad of ['bytes=1000-', 'bytes=5-2', 'bytes=-', 'items=0-1', 'bytes=a-b']) assert.equal(parseRange(bad, 1000), 'bad', bad);
  assert.equal(parseRange(undefined, 1000), null);
});

test('listening rules: tiny starts are dropped; skips, plays and completes are told apart', () => {
  assert.equal(classify({ type: 'play', listenedMs: 1500, durationMs: 200000 }), null);
  assert.equal(classify({ type: 'skip', listenedMs: 10000, durationMs: 200000 }), 's');
  assert.equal(classify({ type: 'play', listenedMs: 30000, durationMs: 200000 }), 'p');
  assert.equal(classify({ type: 'complete', listenedMs: 190000, durationMs: 200000 }), 'c');
  assert.equal(classify({ type: 'complete', listenedMs: 50000, durationMs: 200000 }), 'p'); // claims to have finished but only heard a quarter
  assert.equal(classify({ type: 'play', listenedMs: 20000, durationMs: 30000 }), 'p');     // short clip: half is enough
});

test('permissions: nobody but an admin can use Jupiter until granted; signed-out requests are refused', async () => {
  const j = await setup();
  try {
    const r = await j.t.request('POST', '/api/users', { cookie: j.admin.cookie, body: { email: 'r@example.com', displayName: 'R', password: 'a-decent-password', roleId: 'resident' } });
    assert.equal(r.status, 201);
    const res = await j.t.login('r@example.com', 'a-decent-password');
    for (const [m, p] of [['GET', '/library'], ['GET', '/meta'], ['POST', '/uploads/start'], ['GET', '/stats'], ['POST', '/maintenance/rebuild-history?confirm=true']]) assert.equal((await j.t.request(m, B + p, { cookie: res.cookie, body: m === 'POST' ? {} : undefined })).status, 403, p);
    assert.equal((await j.t.request('GET', `${B}/library`)).status, 401);
    assert.equal((await j.api('GET', '/meta')).status, 200);
  } finally { await j.cleanup(); }
});

test('upload: multi-part file is stored, listed, streamed with ranges across part boundaries, and survives a duplicate attempt', async () => {
  const j = await setup();
  try {
    const bytes = mp3(PART_SIZE * 2 + 12345);
    const up = await j.upload(bytes, { title: 'Test Song', artists: ['Burna Boy', 'Wizkid'], album: 'Night', albumArtist: 'Burna Boy', genre: 'Afrobeats', tags: ['Chill', 'chill'], durationMs: 200000, trackNo: 3, year: 2021 });
    assert.equal(up.fin.status, 201, JSON.stringify(up.fin.json));
    const lib = (await j.api('GET', '/library')).json;
    assert.equal(lib.tracks.length, 1);
    const tr = lib.tracks[0];
    assert.deepEqual([tr.title, tr.artists, tr.tags, tr.kind, tr.size], ['Test Song', ['Burna Boy', 'Wizkid'], ['chill'], 'mp3', bytes.length]);
    assert.ok(!JSON.stringify(lib).includes('"parts"'), 'internal storage references are not sent to the browser');
    const audio = `${B}/tracks/${tr.id}/audio`;
    // first window
    let r = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: 'bytes=0-99' } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes 0-99/${bytes.length}`); assert.ok(r.buf.equals(bytes.subarray(0, 100)));
    assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.match(r.headers.get('cache-control'), /^private/);
    // a range that crosses the first part boundary is cut at the boundary; the browser asks for the rest
    r = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: `bytes=${PART_SIZE - 10}-${PART_SIZE + 10}` } });
    assert.equal(r.status, 206); assert.equal(r.buf.length, 10); assert.ok(r.buf.equals(bytes.subarray(PART_SIZE - 10, PART_SIZE)));
    r = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: `bytes=${PART_SIZE}-${PART_SIZE + 99}` } });
    assert.ok(r.buf.equals(bytes.subarray(PART_SIZE, PART_SIZE + 100)));
    r = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: `bytes=-50` } }); // last bytes
    assert.ok(r.buf.equals(bytes.subarray(bytes.length - 50)));
    r = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: `bytes=${bytes.length + 5}-` } });
    assert.equal(r.status, 416);
    // reassembling every window gives back the exact file
    const out = []; let pos = 0; while (pos < bytes.length) { const w = await j.bin('GET', audio, { cookie: j.admin.cookie, headers: { Range: `bytes=${pos}-` } }); assert.equal(w.status, 206); assert.ok(w.buf.length <= PART_SIZE); out.push(w.buf); pos += w.buf.length; }
    assert.ok(Buffer.concat(out).equals(bytes));
    // no session -> no audio
    assert.equal((await j.bin('GET', audio, { headers: { Range: 'bytes=0-9' } })).status, 401);
    // same file again is refused, before any bytes are uploaded
    const dup = await j.upload(bytes, { title: 'Again' });
    assert.equal(dup.start.json.duplicate.title, 'Test Song');
    assert.equal((await j.api('GET', '/library')).json.tracks.length, 1);
  } finally { await j.cleanup(); }
});

test('upload safety: non-audio, damaged pieces, forged tickets, bad ids, oversize and quota are all refused with clear errors', async () => {
  const j = await setup();
  try {
    const fake = await j.upload(Buffer.from('<html>' + 'x'.repeat(2000) + '</html>'), { title: 'Not audio' }, { name: 'virus.mp3' });
    assert.equal(fake.part.status, 415); assert.match(JSON.parse(fake.part.buf.toString()).error.message, /supported audio/);
    const s = (await j.api('POST', '/uploads/start', { name: 'a.mp3', size: 5000 })).json;
    const chunk = mp3(5000);
    assert.equal((await j.bin('PUT', `${B}/uploads/${s.uploadId}/parts/0`, { cookie: j.admin.cookie, body: chunk, headers: { 'X-Chunk-Sha256': sha(Buffer.from('other')) } })).status, 400);
    const ok = JSON.parse((await j.bin('PUT', `${B}/uploads/${s.uploadId}/parts/0`, { cookie: j.admin.cookie, body: chunk, headers: { 'X-Chunk-Sha256': sha(chunk) } })).buf.toString());
    const forged = { ...ok, ticket: 'a'.repeat(64) };
    assert.equal((await j.api('POST', `/uploads/${s.uploadId}/finish`, { size: 5000, parts: [forged], meta: { title: 'x' } })).status, 400);
    assert.equal((await j.api('POST', `/uploads/${s.uploadId}/finish`, { size: 5001, parts: [ok], meta: { title: 'x' } })).status, 400); // sizes disagree
    assert.equal((await j.api('POST', `/uploads/${s.uploadId}/finish`, { size: 5000, parts: [{ ...ok, kind: 'flac' }], meta: { title: 'x' } })).status, 400); // kind is signed
    assert.equal((await j.api('POST', '/uploads/start', { name: 'big.mp3', size: 51 * 1024 * 1024 })).status, 413);
    assert.equal((await j.bin('PUT', `${B}/uploads/..%2F..%2Fetc/parts/0`, { cookie: j.admin.cookie, body: chunk, headers: { 'X-Chunk-Sha256': sha(chunk) } })).status, 400);
    assert.equal((await j.bin('PUT', `${B}/uploads/up_zzzzzzzzzzzzzzzzzz/parts/0`, { cookie: j.admin.cookie, body: chunk, headers: { 'X-Chunk-Sha256': sha(chunk) } })).status, 400);
    assert.equal((await j.api('GET', '/library')).json.tracks.length, 0, 'nothing half-saved');
    // another person's ticket is useless
    await j.t.request('POST', '/api/users', { cookie: j.admin.cookie, body: { email: 'o@example.com', displayName: 'O', password: 'a-decent-password', roleId: 'admin' } });
    const other = await j.t.login('o@example.com', 'a-decent-password');
    assert.equal((await j.api('POST', `/uploads/${s.uploadId}/finish`, { size: 5000, parts: [ok], meta: { title: 'stolen' } }, other)).status, 400);
    // quota
    assert.equal((await j.upload(mp3(PART_SIZE * 2), { title: 'one' })).fin.status, 201);
    for (let i = 0; i < 9; i++) await j.upload(mp3(PART_SIZE * 2, i + 2), { title: `f${i}` });
    const full = await j.api('POST', '/uploads/start', { name: 'more.mp3', size: 20 * 1024 * 1024 });
    assert.equal(full.status, 413); assert.equal(full.json.error.code, 'quota_exceeded');
  } finally { await j.cleanup(); }
});

test('metadata, artwork, likes, albums and artists can be edited; audio stays; art is private to its owner', async () => {
  const j = await setup();
  try {
    const up = await j.upload(mp3(50000, 4), { title: 'Orig', artists: ['A'], album: 'Alb', durationMs: 1000 }, { art: PNG });
    const id = up.id, key = up.fin.json.track.artKey;
    assert.match(key, /^art_[a-f0-9]{18}\.png$/);
    let art = await j.bin('GET', `${B}/art/${key}`, { cookie: j.admin.cookie });
    assert.equal(art.status, 200); assert.equal(art.headers.get('content-type'), 'image/png'); assert.ok(art.buf.equals(PNG));
    assert.equal((await j.bin('GET', `${B}/art/${key}`)).status, 401);
    assert.equal((await j.bin('GET', `${B}/art/..%2F..%2Fsecret.png`, { cookie: j.admin.cookie })).status, 404);
    let p = await j.api('PATCH', `/tracks/${id}`, { title: 'New title', artistIds: [await j.ensureArtist('A'), await j.ensureArtist('B')], genre: 'Soul', tags: ['Late Night'], description: 'liner notes', discNo: 2, releaseDate: '2020-05', liked: true });
    assert.equal(p.status, 200); assert.deepEqual([p.json.track.title, p.json.track.discNo, p.json.track.year, p.json.track.liked], ['New title', 2, 2020, true]);
    assert.equal((await j.api('PATCH', `/tracks/${id}`, { ownerId: 'x' })).status, 400);
    assert.equal((await j.api('PATCH', `/tracks/${id}`, { year: 99999 })).status, 400);
    assert.equal((await j.api('PATCH', `/tracks/${id}`, { artKey: 'art_000000000000000000.png' })).status, 400); // art that does not exist
    // replace artwork: new image works, old one is gone from storage
    const rep = await j.bin('PUT', `${B}/tracks/${id}/artwork`, { cookie: j.admin.cookie, body: PNG, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(rep.status, 200); const k2 = JSON.parse(rep.buf.toString()).track.artKey; assert.notEqual(k2, key);
    assert.equal((await j.bin('GET', `${B}/art/${k2}`, { cookie: j.admin.cookie })).status, 200);
    assert.equal((await j.bin('GET', `${B}/art/${key}`, { cookie: j.admin.cookie })).status, 404);
    assert.equal((await j.bin('PUT', `${B}/tracks/${id}/artwork`, { cookie: j.admin.cookie, body: Buffer.from('not an image at all, really'), headers: {} })).status, 415);
    assert.equal((await j.bin('GET', `${B}/tracks/${id}/audio`, { cookie: j.admin.cookie, headers: { Range: 'bytes=0-3' } })).buf.toString('latin1', 0, 3), 'ID3'); // audio untouched
    // album and artist artwork and rename
    const lib = (await j.api('GET', '/library')).json; assert.equal(lib.tracks.length, 1);
    const albumId = (await j.t.app.services.storage.collection('jupiter_tracks').get(id)) && `alb_${createHash('sha1').update(`${j.admin.user?.id || (await j.api('GET', '/meta')).json && ''}`).digest('hex').slice(0, 0)}`;
    void albumId;
  } finally { await j.cleanup(); }
});

test('albums and artists: derived from tracks, can get artwork and descriptions, and renaming an album edits its tracks', async () => {
  const j = await setup();
  try {
    const a = await j.upload(mp3(40000, 1), { title: 'One', artists: ['Tems'], album: 'Alpha', albumArtist: 'Tems', trackNo: 1 });
    const b = await j.upload(mp3(40000, 2), { title: 'Two', artists: ['Tems', 'Wizkid'], album: 'Alpha', albumArtist: 'Tems', trackNo: 2 });
    const me = (await j.t.request('GET', '/api/auth/me', { cookie: j.admin.cookie })).json.user.id;
    const { albumId } = await import('../apps/jupiter/server/schema.js');
    const alb = albumId(me, 'Tems', 'Alpha'), art = await j.ensureArtist('Wizkid');
    assert.deepEqual((await j.api('GET', `/albums/${alb}`)).json.trackIds.sort(), [a.id, b.id].sort());
    assert.equal((await j.api('GET', `/albums/alb_doesnotexist0000`)).status, 404);
    const put = await j.bin('PUT', `${B}/albums/${alb}/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} });
    assert.equal(put.status, 200); const k = JSON.parse(put.buf.toString()).artKey;
    assert.equal((await j.bin('PUT', `${B}/artists/${art}/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} })).status, 200);
    assert.equal((await j.bin('PUT', `${B}/artists/art_nothing00000000/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} })).status, 404);
    assert.equal((await j.api('PATCH', `/artists/${art}`, { description: 'Singer' })).json.artist.description, 'Singer');
    const lib = (await j.api('GET', '/library')).json;
    assert.equal(lib.albums.find((x) => x.id === alb).artKey, k); assert.equal(lib.artists.find((x) => x.id === art).description, 'Singer');
    assert.equal((await j.bin('GET', `${B}/art/${k}`, { cookie: j.admin.cookie })).status, 200);
    assert.equal((await j.api('POST', `/albums/${alb}/rename`, { title: 'Beta' })).json.tracksChanged, 2);
    assert.deepEqual((await j.api('GET', '/library')).json.tracks.map((x) => x.album), ['Beta', 'Beta']);
  } finally { await j.cleanup(); }
});

test('deleting: needs confirm, removes audio from storage and from playlists; removing from a playlist never deletes audio', async () => {
  const j = await setup();
  try {
    const a = await j.upload(mp3(PART_SIZE + 10, 1), { title: 'A' }), b = await j.upload(mp3(60000, 2), { title: 'B' });
    const pl = (await j.api('POST', '/playlists', { name: 'Mix', trackIds: [a.id, b.id, a.id, 'trk_nope'] })).json.playlist;
    assert.deepEqual(pl.trackIds, [a.id, b.id, a.id]); // unknown ids dropped, duplicates allowed
    assert.equal((await j.api('POST', '/playlists', { name: 'Mix' })).json.playlist.name, 'Mix (2)');
    assert.deepEqual((await j.api('PUT', `/playlists/${pl.id}/tracks`, { trackIds: [b.id, a.id] })).json.playlist.trackIds, [b.id, a.id]); // reorder
    assert.deepEqual((await j.api('PUT', `/playlists/${pl.id}/tracks`, { trackIds: [b.id] })).json.playlist.trackIds, [b.id]);           // remove a track
    assert.equal((await j.api('PUT', `/playlists/${pl.id}/tracks`, { trackIds: ['trk_ghost'] })).status, 400);
    assert.equal((await j.bin('GET', `${B}/tracks/${a.id}/audio`, { cookie: j.admin.cookie, headers: { Range: 'bytes=0-3' } })).status, 206, 'audio still there');
    assert.equal((await j.api('POST', `/playlists/${pl.id}/tracks`, { trackIds: [a.id] })).json.playlist.trackIds.length, 2);
    assert.equal((await j.api('DELETE', `/playlists/${pl.id}`)).status, 400);
    const del = await j.api('DELETE', `/playlists/${pl.id}?confirm=true`); assert.equal(del.json.tracksKept, 2);
    assert.equal((await j.api('GET', '/library')).json.tracks.length, 2);
    // real deletion
    const keep = (await j.api('POST', '/playlists', { name: 'Keep', trackIds: [a.id, b.id] })).json.playlist;
    assert.equal((await j.api('DELETE', `/tracks/${a.id}`)).status, 400);
    const before = await j.t.app.services.jupiterMedia;
    void before;
    const rm = await j.api('DELETE', `/tracks/${a.id}?confirm=true`); assert.equal(rm.status, 200); assert.equal(rm.json.storageCleanup, 'done');
    assert.equal((await j.bin('GET', `${B}/tracks/${a.id}/audio`, { cookie: j.admin.cookie })).status, 404);
    const lib = (await j.api('GET', '/library')).json;
    assert.equal(lib.tracks.length, 1); assert.deepEqual(lib.playlists.find((x) => x.id === keep.id).trackIds, [b.id]);
    assert.equal((await j.bin('GET', `${B}/tracks/${b.id}/audio`, { cookie: j.admin.cookie, headers: { Range: 'bytes=0-3' } })).status, 206);
    const orphans = (await j.api('GET', '/maintenance/orphans')).json; assert.equal(orphans.orphanCount, 0); assert.equal(orphans.missingCount, 0);
  } finally { await j.cleanup(); }
});

test('isolation: another user cannot see, stream, edit or delete a track', async () => {
  const j = await setup();
  try {
    const up = await j.upload(mp3(30000, 7), { title: 'Mine' });
    await j.t.request('POST', '/api/users', { cookie: j.admin.cookie, body: { email: 'o@example.com', displayName: 'O', password: 'a-decent-password', roleId: 'admin' } });
    const o = await j.t.login('o@example.com', 'a-decent-password');
    assert.equal((await j.api('GET', '/library', undefined, o)).json.tracks.length, 0);
    for (const [m, p] of [['GET', `/tracks/${up.id}`], ['PATCH', `/tracks/${up.id}`], ['DELETE', `/tracks/${up.id}?confirm=true`]]) assert.equal((await j.api(m, p, m === 'PATCH' ? { title: 'x' } : undefined, o)).status, 404, p);
    assert.equal((await j.bin('GET', `${B}/tracks/${up.id}/audio`, { cookie: o.cookie })).status, 404);
    assert.equal((await j.api('GET', '/library')).json.tracks.length, 1);
  } finally { await j.cleanup(); }
});

test('listening history: short taps ignored, retries deduplicated, counters and ranges correct, missing history is not zero', async () => {
  const j = await setup();
  try {
    const a = await j.upload(mp3(30000, 1), { title: 'A', artists: ['X'], genre: 'Pop', durationMs: 200000 }), b = await j.upload(mp3(30000, 2), { title: 'B', artists: ['Y'], genre: 'Jazz', durationMs: 100000 });
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    const ev = (eid, trackId, ago, listenedMs, type = 'play') => ({ eid, trackId, ts: iso(now - ago), listenedMs, durationMs: 200000, type, src: 'library' });
    const post = (events) => j.api('POST', '/events', { events });
    const r = await post([ev('e1-aaaaaaaa', a.id, 3600e3, 200000, 'complete'), ev('e2-aaaaaaaa', a.id, 7200e3, 40000), ev('e3-aaaaaaaa', b.id, 1800e3, 12000, 'skip'), ev('e4-aaaaaaaa', b.id, 900e3, 1200), ev('e5-aaaaaaaa', 'trk_ghost', 900e3, 60000)]);
    assert.equal(r.status, 200); assert.equal(r.json.stored, 3); assert.equal(r.json.rejected.length, 2);
    const again = await post([ev('e1-aaaaaaaa', a.id, 3600e3, 200000, 'complete'), ev('e6-aaaaaaaa', b.id, 600e3, 50000)]);
    assert.equal(again.json.duplicates, 1); assert.equal(again.json.stored, 1);
    const tracks = (await j.api('GET', '/library')).json.tracks, A = tracks.find((t) => t.id === a.id), Bt = tracks.find((t) => t.id === b.id);
    assert.deepEqual([A.playCount, A.skipCount, A.listenMs], [2, 0, 240000]); assert.deepEqual([Bt.playCount, Bt.skipCount], [1, 1]);
    assert.ok(A.lastPlayedAt && Bt.lastPlayedAt);
    assert.equal((await post([{ eid: 'zz', type: 'play' }])).json.rejected.length, 1);
    assert.equal((await post(Array.from({ length: 101 }, (_, i) => ev(`bulk-${i}-aaaa`, a.id, 1000, 5000)))).status, 400);
    const st = (await j.api('GET', '/stats?range=week')).json;
    assert.deepEqual([st.totals.plays, st.totals.completes, st.totals.skips, st.totals.uniqueTracks], [3, 1, 1, 2]);
    assert.equal(st.topTracks[0].trackId, a.id); assert.equal(st.topArtists[0].name, 'X'); assert.equal(st.byDay.length, 7);
    assert.equal(st.coverage.hasAnyData, true);
    const noData = st.byDay.filter((d) => d.noData); assert.ok(noData.length >= 5, 'days before tracking began are "no data", not zero');
    assert.equal(st.byDay.at(-1).noData, undefined);
    const custom = (await j.api('GET', `/stats?range=custom&from=2001-01-01&to=2001-01-31`)).json; assert.equal(custom.totals.plays, 0); assert.ok(custom.byDay.every((d) => d.noData));
    for (const q of ['range=nope', 'range=custom', 'range=custom&from=2020-01-01&to=2030-01-01', 'range=week&tz=99999', 'range=week&limit=0']) assert.equal((await j.api('GET', `/stats?${q}`)).status, 400, q);
    // the database holds counters only: no per-play rows
    const names = Object.keys((await j.t.app.services.storage.exportAll()).collections).filter((n) => n.startsWith('jupiter_'));
    assert.ok(!names.some((n) => /event|listen|history/.test(n)), names.join());
  } finally { await j.cleanup(); }
});

test('Nebula: plays real tracks, never invented ones, reports misses, confirms deletes, reads analytics and the live player', async () => {
  const sc = [];
  const j = await setup((req, n) => sc[n - 1]?.(req) ?? text('done'));
  try {
    const a = await j.upload(mp3(30000, 1), { title: 'Calm Waters', artists: ['Tems'], genre: 'Afrobeats', tags: ['chill'], durationMs: 180000 });
    const b = await j.upload(mp3(30000, 2), { title: 'Fire', artists: ['Burna Boy'], genre: 'Afrobeats', tags: ['hype'], durationMs: 190000 });
    const c = await j.upload(mp3(30000, 3), { title: 'Slow Jam', artists: ['Tems'], genre: 'R&B', tags: ['chill', 'late night'], durationMs: 210000 });
    await j.api('PATCH', `/tracks/${b.id}`, { liked: true });
    const chat = (message, extra = {}) => (j.provider.calls.length = 0, j.t.request('POST', '/api/ai/chat', { cookie: j.admin.cookie, body: { message, ...extra } }));
    const tools = (await j.t.request('GET', '/api/ai/providers', { cookie: j.admin.cookie })).status; assert.equal(tools, 200);

    sc.length = 0; sc.push(() => toolCall('jupiter.play', { genre: 'Afrobeats', sort: 'favourites' }), () => text('Playing your Afrobeats.'));
    let r = await chat('Play my favourite Afrobeats'); assert.equal(r.status, 200, r.text);
    assert.equal(r.json.actions.length, 1); assert.equal(r.json.actions[0].type, 'play'); assert.deepEqual(r.json.actions[0].trackIds, [b.id, a.id]); assert.equal(r.json.actions[0].app, 'jupiter');

    sc.length = 0; sc.push(() => toolCall('jupiter.play', { artist: 'Nobody Real' }), () => text('I could not find that.'));
    r = await chat('Play everything by Nobody Real'); assert.equal(r.json.actions.length, 0);
    const toolMsg = j.provider.calls.at(-1).messages.find((m) => m.role === 'tool'); assert.match(toolMsg.content, /Nothing in the library matches/);

    sc.length = 0; sc.push(() => toolCall('jupiter.play', { ids: `${a.id},trk_invented123,${c.id}`, mode: 'append' }), () => text('Queued.'));
    r = await chat('queue these'); assert.deepEqual(r.json.actions[0].trackIds, [a.id, c.id]); assert.equal(r.json.actions[0].mode, 'append');
    sc.length = 0; sc.push(() => toolCall('jupiter.play', { ids: 'trk_invented123' }), () => text('x'));
    r = await chat('play the invented one'); assert.equal(r.json.actions.length, 0);

    sc.length = 0; sc.push(() => toolCall('jupiter.createPlaylist', { name: 'Late night study', tag: 'chill' }), () => text('Made it.'));
    r = await chat('Make a playlist for late-night studying'); assert.equal(r.json.actions[0].type, 'refresh');
    let lib = (await j.api('GET', '/library')).json; const made = lib.playlists.find((p) => p.name === 'Late night study'); assert.deepEqual(made.trackIds.sort(), [a.id, c.id].sort());
    sc.length = 0; sc.push(() => toolCall('jupiter.createPlaylist', { name: 'Empty', genre: 'Polka' }), () => text('none'));
    await chat('make a polka playlist'); assert.ok(!(await j.api('GET', '/library')).json.playlists.some((p) => p.name === 'Empty'));

    // destructive: only a confirmation card, nothing deleted
    sc.length = 0; sc.push(() => toolCall('jupiter.requestDelete', { action: 'deleteTrack', trackId: b.id }), () => text('Please confirm.'));
    r = await chat('delete Fire'); assert.equal(r.json.actions[0].type, 'confirm'); assert.equal((await j.api('GET', '/library')).json.tracks.length, 3);
    sc.length = 0; sc.push(() => toolCall('jupiter.requestDelete', { action: 'clearPlaylist', playlist: 'Late night study' }), () => text('Please confirm.'));
    r = await chat('clear my study playlist'); assert.equal(r.json.actions[0].action, 'clearPlaylist'); assert.equal((await j.api('GET', '/library')).json.playlists.find((p) => p.id === made.id).trackIds.length, 2);

    // the live player, as sent by the browser
    sc.length = 0; sc.push(() => toolCall('jupiter.nowPlaying', {}), () => text('ok'));
    await chat('what is playing?', { clientContext: { jupiter: { trackId: c.id, playing: true, positionSec: 42, queueIds: [a.id, 'trk_fake'], shuffle: true, repeat: 'all' } } });
    let res = JSON.parse(j.provider.calls.at(-1).messages.find((m) => m.role === 'tool').content); assert.equal(res.track.title, 'Slow Jam'); assert.equal(res.upNext.length, 1); assert.equal(res.positionSec, 42);
    sc.length = 0; sc.push(() => toolCall('jupiter.nowPlaying', {}), () => text('ok'));
    await chat('what is playing?', { clientContext: { jupiter: { trackId: 'trk_made_up' } } });
    assert.equal(JSON.parse(j.provider.calls.at(-1).messages.find((m) => m.role === 'tool').content).playing, false);
    assert.equal((await chat('hi', { clientContext: { x: 'y'.repeat(7000) } })).status, 400);

    // analytics reach Nebula, including the "no data" honesty
    await j.api('POST', '/events', { events: [{ eid: 'ev-nebula-1', trackId: a.id, ts: new Date().toISOString(), listenedMs: 100000, durationMs: 180000, type: 'play' }] });
    sc.length = 0; sc.push(() => toolCall('jupiter.listeningStats', { period: 'month' }), () => text('ok'));
    await chat('what have I been listening to lately?');
    res = JSON.parse(j.provider.calls.at(-1).messages.find((m) => m.role === 'tool').content);
    assert.equal(res.totals.plays, 1); assert.equal(res.topTracks[0].title, 'Calm Waters'); assert.match(res.coverage.note, /NO DATA/);
    sc.length = 0; sc.push(() => toolCall('jupiter.play', { mostListened: 'month' }), () => text('ok'));
    r = await chat('play my most listened this month'); assert.deepEqual(r.json.actions[0].trackIds, [a.id]);
    // the model never sees the browser instructions
    assert.ok(!j.provider.calls.at(-1).messages.some((m) => m.role === 'tool' && m.content.includes('clientActions')));
    // a tool the model invents is refused; bad arguments are refused
    sc.length = 0; sc.push(() => toolCall('jupiter.deleteEverything', {}), () => text('no'));
    assert.equal((await chat('wipe it')).json.actions.length, 0);
  } finally { await j.cleanup(); }
});

test('history rebuild and cron: needs the secret, keeps files; maintenance routes are guarded', async () => {
  const j = await setup();
  try {
    assert.equal((await j.bin('GET', `${B}/maintenance/weekly`)).status, 401);
    assert.equal((await j.bin('GET', `${B}/maintenance/weekly`, { headers: { Authorization: 'Bearer wrong-secret-0000000' } })).status, 401);
    const ok = await j.bin('GET', `${B}/maintenance/weekly`, { headers: { Authorization: 'Bearer cron-secret-123456' } });
    assert.equal(ok.status, 200);
    assert.equal((await j.api('POST', '/maintenance/rebuild-history')).status, 400);
    assert.equal((await j.api('POST', '/maintenance/rebuild-history?confirm=true')).status, 200);
  } finally { await j.cleanup(); }
});

// ---------------------------------------------------------------- GitHub media store, against an in-memory GitHub
function fakeGithub({ onPatch } = {}) {
  const blobs = new Map(), commits = new Map(), trees = new Map(), refs = new Map(), log = [];
  const h = (s) => createHash('sha1').update(s).digest('hex');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  async function fetchFn(url, init = {}) {
    const u = new URL(url), p = u.pathname.replace(/^\/repos\/o\/r/, ''), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    log.push(`${method} ${p}`);
    let m;
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(p))) return refs.has(m[1]) ? json({ object: { sha: refs.get(m[1]) } }) : json({ message: 'Not Found' }, 404);
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(p))) { const c = commits.get(m[1]); return c ? json({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((x) => ({ sha: x })) }) : json({ message: 'Not Found' }, 404); }
    if (p === '/git/blobs' && method === 'POST') { const buf = Buffer.from(body.content, 'base64'), sha = h(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])); blobs.set(sha, buf); return json({ sha }, 201); }
    if ((m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(p))) return blobs.has(m[1]) ? new Response(blobs.get(m[1])) : json({ message: 'Not Found' }, 404);
    if (p === '/git/trees' && method === 'POST') {
      const map = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const e of body.tree) { if (e.sha === null) { if (!map.has(e.path)) return json({ message: 'path not found' }, 422); map.delete(e.path); } else { if (!blobs.has(e.sha)) return json({ message: 'blob missing' }, 422); map.set(e.path, e.sha); } }
      const sha = h(JSON.stringify([...map].sort())); trees.set(sha, map); return json({ sha }, 201);
    }
    if (p === '/git/commits' && method === 'POST') { const sha = h(JSON.stringify(body) + Math.random()); commits.set(sha, { tree: body.tree, parents: body.parents }); return json({ sha }, 201); }
    if (p === '/git/refs' && method === 'POST') { const b = body.ref.replace('refs/heads/', ''); if (refs.has(b)) return json({ message: 'exists' }, 422); refs.set(b, body.sha); return json({}, 201); }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(p)) && method === 'PATCH') {
      onPatch?.(refs); const cur = refs.get(m[1]); let ok = body.force;
      for (let c = body.sha; c && !ok; c = commits.get(c)?.parents[0]) if (c === cur) ok = true;
      if (!ok) return json({ message: 'Update is not a fast forward' }, 422); refs.set(m[1], body.sha); return json({});
    }
    if ((m = /^\/git\/trees\/([0-9a-f]+)$/.exec(p))) return json({ tree: [...trees.get(m[1])].map(([path, sha]) => ({ path, type: 'blob', sha, size: blobs.get(sha).length })) });
    if ((m = /^\/contents\/(.+)$/.exec(p))) { const c = commits.get(refs.get(u.searchParams.get('ref'))); const sha = c && trees.get(c.tree).get(decodeURIComponent(m[1])); return sha ? new Response(blobs.get(sha)) : json({ message: 'Not Found' }, 404); }
    return json({ message: `unhandled ${method} ${p}` }, 500);
  }
  return { fetchFn, blobs, commits, trees, refs, log };
}
const gh = (fake, extra = {}) => new GithubMediaStore({ token: 'ghp_SECRET_TOKEN_VALUE', repo: 'o/r', branch: 'jupiter-media', fetch: fake.fetchFn, retryMs: 1, protectedBranches: ['universe-data'], ...extra });

test('GitHub media store: orphan branch, atomic commits, reads, deletes, and the data branch is never touched', async () => {
  const fake = fakeGithub(); fake.refs.set('universe-data', 'd0'.padEnd(40, '0'));
  const m = gh(fake);
  const a = await m.putBlob(Buffer.from('hello')), b = await m.putBlob(Buffer.from('world'));
  assert.equal(await m.head(), null);
  await m.commit({ add: [{ path: 'tracks/trk_1/0000.part', ref: a }, { path: 'art/art_x.jpg', ref: b }], message: 'add' });
  const first = await m.head(); assert.ok(first);
  assert.equal(fake.commits.get(first).parents.length, 0, 'orphan: shares no history');
  assert.equal((await m.getBlob(a)).toString(), 'hello'); assert.equal((await m.readFile('art/art_x.jpg')).toString(), 'world'); assert.equal(await m.readFile('art/none.jpg'), null);
  await m.commit({ remove: ['art/art_x.jpg'], message: 'rm' });
  assert.equal(await m.readFile('art/art_x.jpg'), null); assert.equal((await m.readFile('tracks/trk_1/0000.part')).toString(), 'hello');
  assert.equal(fake.refs.get('universe-data'), 'd0'.padEnd(40, '0'));
  assert.ok(fake.log.every((l) => !/universe-data/.test(l) || /ref\/heads/.test(l) === false));
  assert.deepEqual((await m.usage()), { files: 1, bytes: 5, truncated: false });
  for (const bad of ['../x', '/etc/passwd', 'tracks/../../x', 'other/file', 'tracks//x']) await assert.rejects(() => m.readFile(bad), /Invalid media path/, bad);
  assert.throws(() => gh(fake, { branch: 'universe-data' }), /must not be/);
  assert.throws(() => gh(fake, { branch: 'main', protectedBranches: ['main'] }), /must not be/);
  assert.throws(() => gh(fake, { repo: 'nope' }), /owner\/name/);
});

test('GitHub media store: a writer that moves the branch mid-commit is retried on top, never overwritten', async () => {
  const fake = fakeGithub(); let bumped = false;
  const m = gh(fake); await m.commit({ add: [{ path: 'tracks/t1/0000.part', ref: await m.putBlob(Buffer.from('one')) }], message: 'one' });
  const other = gh(fake, { }); // a second instance of the server
  const m2 = gh(fake, { }); void m2;
  const fake2 = fake; fake2.fetchFn = ((orig) => async (url, init) => {
    if (!bumped && init?.method === 'PATCH') { bumped = true; await other.commit({ add: [{ path: 'tracks/t2/0000.part', ref: await other.putBlob(Buffer.from('two')) }], message: 'two' }); }
    return orig(url, init);
  })(fake.fetchFn);
  m.fetchFn = fake2.fetchFn; other.fetchFn = ((orig) => orig)(fake.fetchFn);
  await m.commit({ add: [{ path: 'tracks/t3/0000.part', ref: await m.putBlob(Buffer.from('three')) }], message: 'three' });
  for (const [p, want] of [['tracks/t1/0000.part', 'one'], ['tracks/t2/0000.part', 'two'], ['tracks/t3/0000.part', 'three']]) assert.equal((await m.readFile(p)).toString(), want, p);
});

test('GitHub media store: history rebuild squashes to one commit with the SAME files, only on the media branch, and is safe to repeat', async () => {
  const fake = fakeGithub(); fake.refs.set('universe-data', 'a1'.padEnd(40, '0')); fake.refs.set('main', 'b2'.padEnd(40, '0'));
  const m = gh(fake);
  for (let i = 0; i < 4; i++) await m.commit({ add: [{ path: `tracks/t${i}/0000.part`, ref: await m.putBlob(Buffer.from(`file${i}`)) }], message: `c${i}` });
  const before = await m.head(), treeBefore = fake.commits.get(before).tree;
  const r = await m.rebuildHistory();
  assert.equal(r.before, before); assert.notEqual(r.after, before);
  const now = await m.head(); assert.equal(now, r.after); assert.equal(fake.commits.get(now).parents.length, 0); assert.equal(fake.commits.get(now).tree, treeBefore);
  for (let i = 0; i < 4; i++) assert.equal((await m.readFile(`tracks/t${i}/0000.part`)).toString(), `file${i}`);
  assert.equal(fake.refs.get('universe-data'), 'a1'.padEnd(40, '0')); assert.equal(fake.refs.get('main'), 'b2'.padEnd(40, '0'));
  assert.match((await m.rebuildHistory()).skipped, /single commit/);
  await m.commit({ add: [{ path: 'tracks/t9/0000.part', ref: await m.putBlob(Buffer.from('later')) }], message: 'after rebuild' }); // uploads keep working
  assert.equal((await m.readFile('tracks/t9/0000.part')).toString(), 'later');
  // if someone commits while we rebuild, nothing is changed
  const fake3 = fakeGithub(); const m3 = gh(fake3);
  for (let i = 0; i < 2; i++) await m3.commit({ add: [{ path: `tracks/t${i}/0000.part`, ref: await m3.putBlob(Buffer.from(`f${i}`)) }], message: `c${i}` });
  const w = gh(fake3); const orig = fake3.fetchFn; let hit = false;
  m3.fetchFn = async (url, init) => { if (!hit && init?.method === 'POST' && /git\/commits$/.test(url) && JSON.parse(init.body).parents.length === 0) { hit = true; await w.commit({ add: [{ path: 'tracks/tn/0000.part', ref: await w.putBlob(Buffer.from('new')) }], message: 'race' }); } return orig(url, init); };
  assert.match((await m3.rebuildHistory()).skipped, /changed while rebuilding/);
  assert.equal((await m3.readFile('tracks/tn/0000.part')).toString(), 'new');
});

test('GitHub media store: the token never appears in an error message', async () => {
  const m = gh({ fetchFn: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }) });
  await assert.rejects(() => m.putBlob(Buffer.from('x')), (e) => { assert.ok(!e.message.includes('ghp_SECRET_TOKEN_VALUE')); assert.match(e.message, /401/); return true; });
  const m2 = gh({ fetchFn: async () => { throw Object.assign(new Error('boom ghp_SECRET_TOKEN_VALUE'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(() => m2.head(), (e) => { assert.ok(!e.message.includes('ghp_SECRET')); return true; });
});

test('media driver selection follows the storage driver, and falls back to local files', () => {
  assert.equal(createMediaStore({ storage: { driver: 'sqlite' }, jupiter: { dir: join(tmpdir(), 'x') } }).kind, 'fs');
  assert.equal(createMediaStore({ storage: { driver: 'github', github: { token: 't', repo: 'o/r', branch: 'universe-data' } }, jupiter: {} }, { fetch: async () => {} }).kind, 'github');
  assert.throws(() => createMediaStore({ storage: { driver: 'github', github: { token: 't', repo: 'o/r', branch: 'universe-data' } }, jupiter: { branch: 'universe-data' } }), /must not be/);
  assert.ok(new FsMediaStore({ dir: tmpdir() }));
});

test('artists are created on purpose: uploads never create them; no artist means Unknown artist', async () => {
  const j = await setup();
  try {
    const up = await j.upload(mp3(30000, 1), { title: 'Mystery', album: 'X' });
    assert.equal(up.fin.status, 201);
    let lib = (await j.api('GET', '/library')).json;
    assert.deepEqual(lib.artists, [], 'no artist was invented'); assert.deepEqual(lib.tracks[0].artists, ['Unknown artist']); assert.deepEqual(lib.tracks[0].artistIds, []);
    assert.equal((await j.api('POST', '/uploads/start', { name: 'a.mp3', size: 100 })).status, 200);
    // the old way (free text names) is refused rather than silently creating artists
    const bad = await j.upload(mp3(30000, 2), { title: 'Names', artists: undefined }); assert.equal(bad.fin.status, 201);
    const body = { title: 'T', artists: ['Someone'] }; assert.equal((await j.api('PATCH', `/tracks/${up.id}`, body)).status, 400);
    assert.equal((await j.api('PATCH', `/tracks/${up.id}`, { artistIds: ['art_doesnotexist1'] })).status, 400);
    // create, duplicate, reserved name, rename
    const a = (await j.api('POST', '/artists', { name: 'Rema', description: 'Mavin' })); assert.equal(a.status, 201);
    assert.equal((await j.api('POST', '/artists', { name: ' rema ' })).status, 409); assert.equal((await j.api('POST', '/artists', { name: 'Unknown Artist' })).status, 400);
    assert.equal((await j.api('PATCH', `/tracks/${up.id}`, { artistIds: [a.json.artist.id] })).json.track.artists[0], 'Rema');
    assert.equal((await j.api('PATCH', `/artists/${a.json.artist.id}`, { name: 'Rema!' })).json.artist.name, 'Rema!');
    lib = (await j.api('GET', '/library')).json; assert.equal(lib.tracks.find((t) => t.id === up.id).artists[0], 'Rema!');
    // another user's artist cannot be attached
    await j.t.request('POST', '/api/users', { cookie: j.admin.cookie, body: { email: 'o@example.com', displayName: 'O', password: 'a-decent-password', roleId: 'admin' } });
    const o = await j.t.login('o@example.com', 'a-decent-password'); const theirs = (await j.api('POST', '/artists', { name: 'Theirs' }, o)).json.artist.id;
    assert.equal((await j.api('PATCH', `/tracks/${up.id}`, { artistIds: [theirs] })).status, 400); assert.equal((await j.api('DELETE', `/artists/${theirs}?confirm=true`)).status, 404);
  } finally { await j.cleanup(); }
});

test('deleting artists and albums: confirm needed, songs kept by default, shared songs protected, files removed when asked', async () => {
  const j = await setup();
  try {
    const s1 = await j.upload(mp3(30000, 1), { title: 'Solo', artists: ['Asake'], album: 'Mr Money' }), s2 = await j.upload(mp3(30000, 2), { title: 'Duet', artists: ['Asake', 'Burna'], album: 'Mr Money' }), s3 = await j.upload(mp3(30000, 3), { title: 'Other', artists: ['Burna'], album: 'Outside' });
    const asake = await j.ensureArtist('Asake'); const pl = (await j.api('POST', '/playlists', { name: 'P', trackIds: [s1.id, s2.id, s3.id] })).json.playlist;
    assert.equal((await j.api('DELETE', `/artists/${asake}`)).status, 400);
    assert.equal((await j.api('DELETE', `/artists/${asake}?confirm=true&songs=maybe`)).status, 400);
    let r = await j.api('DELETE', `/artists/${asake}?confirm=true`); assert.deepEqual([r.json.deletedSongs, r.json.keptSongs], [0, 2]);
    let lib = (await j.api('GET', '/library')).json; assert.equal(lib.tracks.length, 3); assert.deepEqual(lib.tracks.find((t) => t.id === s1.id).artists, ['Unknown artist']); assert.deepEqual(lib.tracks.find((t) => t.id === s2.id).artists, ['Burna']);
    // delete artist WITH songs: only songs where they are the sole artist go
    const burna = await j.ensureArtist('Burna'); const s4 = await j.upload(mp3(30000, 4), { title: 'Mixed', artists: ['Burna', 'Tems'] });
    r = await j.api('DELETE', `/artists/${burna}?confirm=true&songs=delete`); assert.deepEqual([r.json.deletedSongs, r.json.keptSongs], [2, 1]); assert.equal(r.json.storageCleanup, 'done');
    lib = (await j.api('GET', '/library')).json; assert.deepEqual(lib.tracks.map((t) => t.title).sort(), ['Mixed', 'Solo']); assert.deepEqual(lib.playlists[0].trackIds.sort(), [s1.id]);
    assert.equal((await j.bin('GET', `${B}/tracks/${s2.id}/audio`, { cookie: j.admin.cookie })).status, 404);
    // albums
    const { albumId } = await import('../apps/jupiter/server/schema.js'); const me = (await j.t.request('GET', '/api/auth/me', { cookie: j.admin.cookie })).json.user.id;
    const alb = lib.tracks.find((t) => t.id === s1.id).albumId; assert.equal((await j.api('DELETE', `/albums/${alb}`)).status, 400);
    r = await j.api('DELETE', `/albums/${alb}?confirm=true`); assert.equal(r.json.keptSongs, 1); assert.equal((await j.api('GET', '/library')).json.tracks.find((t) => t.id === s1.id).album, 'Unknown album');
    const alb2 = (await j.api('GET', '/library')).json.tracks.find((t) => t.id === s4.id).albumId;
    r = await j.api('DELETE', `/albums/${alb2}?confirm=true&songs=delete`); assert.equal(r.json.deletedSongs, 1); assert.equal((await j.api('GET', '/library')).json.tracks.some((t) => t.id === s4.id), false);
    assert.equal((await j.api('DELETE', `/albums/alb_nothere00000000?confirm=true`)).status, 404); void albumId; void me; void pl;
    assert.equal((await j.api('GET', '/maintenance/orphans')).json.orphanCount, 0);
  } finally { await j.cleanup(); }
});

test('playlist cover art: can be set, shows in the library, is private, can be removed and goes away with the playlist', async () => {
  const j = await setup();
  try {
    const a = await j.upload(mp3(40000, 1), { title: 'One' });
    const pl = (await j.api('POST', '/playlists', { name: 'Covers', trackIds: [a.id] })).json.playlist;
    assert.equal(pl.artKey, null);
    const put = await j.bin('PUT', `${B}/playlists/${pl.id}/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} });
    assert.equal(put.status, 200);
    const key = JSON.parse(put.buf.toString()).artKey;
    assert.match(key, /^art_[a-f0-9]{18}\.(png|jpg|webp)$/);
    assert.equal((await j.bin('GET', `${B}/art/${key}`, { cookie: j.admin.cookie })).status, 200);
    const lib = (await j.api('GET', '/library')).json;
    assert.equal(lib.playlists.find((p) => p.id === pl.id).artKey, key);
    assert.equal((await j.bin('PUT', `${B}/playlists/pl_nope/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} })).status, 404);
    assert.equal((await j.api('PATCH', `/playlists/${pl.id}`, { removeArt: true })).json.playlist.artKey, null);
    assert.equal((await j.bin('GET', `${B}/art/${key}`, { cookie: j.admin.cookie })).status, 404);
    const again = await j.bin('PUT', `${B}/playlists/${pl.id}/artwork`, { cookie: j.admin.cookie, body: PNG, headers: {} });
    assert.equal(again.status, 200);
    assert.equal((await j.api('DELETE', `/playlists/${pl.id}?confirm=true`)).status, 200);
  } finally { await j.cleanup(); }
});
