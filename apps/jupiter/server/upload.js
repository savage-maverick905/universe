// Chunked, resumable uploads that fit Vercel's 4.5 MB request limit and Git's file-size limits.
//
//   1. POST /uploads/start            checks size, quota and duplicates, returns an upload id
//   2. PUT  /uploads/:id/parts/:n     one 3 MiB chunk per request. The server hashes it, checks the first bytes of chunk 0 really are audio,
//                                     stores it as an (unreferenced) Git blob and returns a signed ticket
//   3. PUT  /uploads/:id/art          optional cover image (small), same ticket idea
//   4. POST /uploads/:id/finish       the browser sends back its tickets + metadata. The server verifies every signature, writes ONE Git commit
//                                     containing all the parts, and only THEN creates the library record. Nothing is half-saved: if the
//                                     commit fails there is no track; if the record fails afterwards the new files are removed again.
//
// Tickets are HMAC signatures made with a server secret, so a browser cannot point a track at blobs the server did not accept.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest } from '../../../shared/errors.js';
import { newId } from '../../../shared/ids.js';
import { v, allowKeys } from '../../../shared/validate.js';
import { AUDIO_KINDS, sniffAudio, sniffImage } from './audio.js';
import { PART_SIZE } from './library.js';
import { trackMetaIn } from './schema.js';
import { sha256 } from './media.js';

const MAX_ART = 2 * 1024 * 1024, UPLOAD_TTL_MS = 12 * 3600_000;
const HEX64 = /^[0-9a-f]{64}$/, REF = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function makeUploads(s, media, lib) {
  const cfg = () => s.config.jupiter || {};
  const maxFile = () => (cfg().maxFileMb || 200) * 1024 * 1024;
  const quota = () => (cfg().libraryLimitMb || 900) * 1024 * 1024;
  const secret = () => {
    const k = cfg().secret || s.config.ai?.keyEncryptionSecret || '';
    if (k.length < 16) throw new HttpError(503, 'Uploads are not set up: the server needs KEY_ENCRYPTION_SECRET (or JUPITER_SECRET).', 'uploads_unavailable');
    return k;
  };
  const sign = (user, uploadId, ...fields) => createHmac('sha256', secret()).update([user.id, uploadId, ...fields].join('|')).digest('hex');
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
  const checkId = (id) => {
    if (!/^up_[0-9a-z]{6,12}[0-9a-f]{12}$/.test(id || '')) throw badRequest('Invalid upload id');
    const t = parseInt(id.slice(3, id.length - 12), 36);
    if (!Number.isFinite(t) || Date.now() - t > UPLOAD_TTL_MS || t > Date.now() + 60_000) throw new HttpError(410, 'This upload expired. Start it again.', 'upload_expired');
    return id;
  };

  async function readBody(req, limit) {
    if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'That piece of the upload is too large.', 'too_large');
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'That piece of the upload is too large.', 'too_large'); chunks.push(c); }
    return Buffer.concat(chunks, n);
  }

  async function start(user, { name, size, fingerprint }) {
    secret();
    if (!Number.isInteger(size) || size <= 0) throw badRequest('size must be the file size in bytes');
    if (size > maxFile()) throw new HttpError(413, `This file is larger than the ${cfg().maxFileMb || 200} MB limit for one track.`, 'file_too_large');
    const used = (await lib.allTracks(user)).reduce((n, t) => n + (t.size || 0), 0);
    if (used + size > quota()) throw new HttpError(413, `Your music storage is nearly full (${Math.round(used / 1048576)} MB of ${Math.round(quota() / 1048576)} MB). Remove some tracks or raise JUPITER_LIBRARY_LIMIT_MB.`, 'quota_exceeded');
    let duplicate = null;
    if (fingerprint != null) { if (!HEX64.test(fingerprint)) throw badRequest('fingerprint is not valid'); duplicate = await lib.findDuplicate(user, fingerprint); }
    const uploadId = `up_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
    return { uploadId, partSize: PART_SIZE, parts: Math.ceil(size / PART_SIZE), duplicate };
  }

  async function putPart(user, uploadId, index, req) {
    checkId(uploadId);
    const maxParts = Math.ceil(maxFile() / PART_SIZE);
    if (!Number.isInteger(index) || index < 0 || index >= maxParts) throw badRequest('Invalid part number');
    const buf = await readBody(req, PART_SIZE);
    if (!buf.length) throw badRequest('Empty upload piece');
    const digest = sha256(buf), claimed = String(req.headers['x-chunk-sha256'] || '').toLowerCase();
    if (!HEX64.test(claimed) || claimed !== digest) throw new HttpError(400, 'This piece arrived damaged. Retrying it will fix that.', 'checksum_mismatch');
    let kind = '';
    if (index === 0) {
      kind = sniffAudio(buf);
      if (!kind) throw new HttpError(415, 'This does not look like a supported audio file (MP3, M4A/AAC, FLAC, OGG or WAV).', 'unsupported_audio');
    }
    const ref = await media.putBlob(buf);
    return { index, size: buf.length, sha256: digest, ref, kind, ticket: sign(user, uploadId, index, buf.length, digest, ref, kind) };
  }

  async function putArt(user, uploadId, req) {
    checkId(uploadId);
    const buf = await readBody(req, MAX_ART);
    const img = sniffImage(buf);
    if (!img) throw new HttpError(415, 'Cover art must be a JPEG, PNG or WebP image under 2 MB.', 'unsupported_image');
    const digest = sha256(buf), ref = await media.putBlob(buf);
    return { size: buf.length, sha256: digest, ref, ext: img.ext, ticket: sign(user, uploadId, 'art', buf.length, digest, ref, img.ext) };
  }
  // Stores a cover image for an EXISTING track/album/artist (used when replacing artwork later). Returns the new art key.
  async function addArtwork(user, req) {
    const buf = await readBody(req, MAX_ART);
    const img = sniffImage(buf);
    if (!img) throw new HttpError(415, 'Cover art must be a JPEG, PNG or WebP image under 2 MB.', 'unsupported_image');
    const key = `art_${randomBytes(9).toString('hex')}.${img.ext}`;
    const ref = await media.putBlob(buf);
    await media.commit({ add: [{ path: `art/${key}`, ref }], message: 'Jupiter: add artwork' });
    return key;
  }

  async function finish(user, uploadId, body) {
    checkId(uploadId);
    const b = allowKeys(v.object(body), ['name', 'size', 'parts', 'meta', 'art']);
    const size = b.size; if (!Number.isInteger(size) || size <= 0 || size > maxFile()) throw badRequest('size is not valid');
    if (!Array.isArray(b.parts) || !b.parts.length || b.parts.length > Math.ceil(maxFile() / PART_SIZE)) throw badRequest('parts is not valid');
    const parts = [...b.parts].map((p) => v.object(p, 'part')).sort((x, y) => x.index - y.index);
    let total = 0;
    parts.forEach((p, i) => {
      if (p.index !== i) throw badRequest('Some pieces of the upload are missing. Try again.');
      if (!Number.isInteger(p.size) || p.size <= 0 || p.size > PART_SIZE || (i < parts.length - 1 && p.size !== PART_SIZE)) throw badRequest('A piece has the wrong size');
      if (!HEX64.test(p.sha256 || '') || !REF.test(p.ref || '')) throw badRequest('A piece is not valid');
      const kind = i === 0 ? String(p.kind || '') : '';
      if (!same(p.ticket, sign(user, uploadId, p.index, p.size, p.sha256, p.ref, kind))) throw new HttpError(400, 'An upload piece was not accepted by the server. Start the upload again.', 'bad_ticket');
      total += p.size;
    });
    if (total !== size) throw badRequest('The pieces do not add up to the file size. Try again.');
    const kind = parts[0].kind; if (!AUDIO_KINDS[kind]) throw badRequest('Unsupported audio type');
    const contentHash = sha256(parts.map((p) => p.sha256).join(''));
    const meta = trackMetaIn(b.meta ?? {});
    if (await lib.findDuplicate(user, contentHash)) throw new HttpError(409, 'This file is already in your library.', 'duplicate');

    const id = newId('trk'), add = parts.map((p, i) => ({ path: lib.partPath(id, i), ref: p.ref })); let artKey = null;
    if (b.art) {
      const a = v.object(b.art, 'art');
      if (!['jpg', 'png', 'webp'].includes(a.ext) || !same(a.ticket, sign(user, uploadId, 'art', a.size, a.sha256, a.ref, a.ext))) throw new HttpError(400, 'The cover image was not accepted. Try again.', 'bad_ticket');
      artKey = `art_${randomBytes(9).toString('hex')}.${a.ext}`; add.push({ path: `art/${artKey}`, ref: a.ref });
    }
    try { await media.commit({ add, message: `Jupiter: add track ${id}` }); }
    catch (e) { s.log.error?.('Jupiter media commit failed:', e.message); throw new HttpError(503, 'Could not save the music to storage. Nothing was added; try again in a moment.', 'storage_failed'); }
    try {
      const track = await lib.createTrack(user, meta, { size, kind, mime: AUDIO_KINDS[kind].mime, contentHash, originalName: String(b.name || '').slice(0, 200),
        parts: parts.map((p) => ({ ref: p.ref, size: p.size, sha: p.sha256 })) }, artKey, id);
      return { track };
    } catch (e) {
      try { await media.commit({ remove: add.map((a) => a.path), message: `Jupiter: undo failed add ${id}` }); } catch (x) { s.log.error?.('Jupiter cleanup failed:', x.message); }
      throw e;
    }
  }
  return { start, putPart, putArt, addArtwork, finish, readBody, maxFile, quota };
}
