// Validation and normalisation for Jupiter's records. Every function takes untrusted input and returns clean data or throws HttpError(400).
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest } from '../../../shared/errors.js';
import { createHash } from 'node:crypto';

export const LIMITS = { title: 200, name: 200, tags: 30, tagLen: 40, description: 2000, playlistTracks: 2000, artists: 8 };
export const ART_RE = /^art_[a-f0-9]{18}\.(jpg|png|webp)$/;

export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const h16 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
export const albumKey = (albumArtist, album) => `${norm(albumArtist)}|${norm(album)}`;
export const albumId = (ownerId, albumArtist, album) => `alb_${h16(`${ownerId}|${albumKey(albumArtist, album)}`)}`;
export const artistId = (ownerId, name) => `art_${h16(`${ownerId}|${norm(name)}`)}`;

const text = (x, name, max, { allowEmpty = true } = {}) => {
  if (x == null) return '';
  const s = v.string(String(x), name, { max, min: allowEmpty ? 0 : 1 }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
};
const intIn = (x, name, min, max) => {
  if (x == null || x === '') return null;
  const n = Number(x);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const list = (x, name, max, itemMax) => {
  if (x == null) return [];
  if (!Array.isArray(x) || x.length > max) throw badRequest(`${name} must be a list of at most ${max} items`);
  const seen = new Set(), out = [];
  for (const [i, raw] of x.entries()) { const s = text(raw, `${name}[${i}]`, itemMax); if (s && !seen.has(norm(s))) { seen.add(norm(s)); out.push(s); } }
  return out;
};
const date = (x, name) => {
  if (x == null || x === '') return null;
  const s = v.string(String(x), name, { max: 10 });
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) throw badRequest(`${name} must look like 2024, 2024-05 or 2024-05-31`);
  const [y, m = '01', d = '01'] = s.split('-').map(Number);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) throw badRequest(`${name} is not a valid date`);
  return s;
};

const TRACK_KEYS = ['title', 'artistIds', 'album', 'albumArtist', 'trackNo', 'discNo', 'durationMs', 'year', 'releaseDate', 'genre', 'tags', 'description'];
// Track metadata as typed by a person or read from file tags. `partial` = PATCH (only the fields present).
export function trackMetaIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), [...TRACK_KEYS, ...(partial ? ['liked', 'artKey', 'removeArt'] : [])]);
  const out = {};
  const has = (k) => k in b;
  if (!partial || has('title')) { out.title = text(b.title, 'title', LIMITS.title); if (!out.title && !partial) out.title = 'Untitled'; if (!out.title) throw badRequest('title cannot be empty'); }
  // Artists are things the person creates on purpose. A song with none belongs to "Unknown artist"; names are never auto-created from tags.
  if (!partial || has('artistIds')) { const ids = b.artistIds == null ? [] : b.artistIds; if (!Array.isArray(ids) || ids.length > LIMITS.artists) throw badRequest(`artistIds must be a list of at most ${LIMITS.artists} artists`); out.artistIds = [...new Set(ids.map((i) => v.anyId(i, 'artist id')))]; }
  if (!partial || has('album')) out.album = text(b.album, 'album', LIMITS.name) || 'Unknown album';
  if (!partial || has('albumArtist')) out.albumArtist = text(b.albumArtist, 'albumArtist', LIMITS.name);
  if (!partial || has('trackNo')) out.trackNo = intIn(b.trackNo, 'trackNo', 1, 999);
  if (!partial || has('discNo')) out.discNo = intIn(b.discNo, 'discNo', 1, 99);
  if (!partial || has('durationMs')) out.durationMs = intIn(b.durationMs, 'durationMs', 0, 12 * 3600_000) ?? 0;
  if (!partial || has('year')) out.year = intIn(b.year, 'year', 1000, 2200);
  if (!partial || has('releaseDate')) out.releaseDate = date(b.releaseDate, 'releaseDate');
  if (!partial || has('genre')) out.genre = text(b.genre, 'genre', 60);
  if (!partial || has('tags')) out.tags = list(b.tags, 'tags', LIMITS.tags, LIMITS.tagLen).map((t) => t.toLowerCase());
  if (!partial || has('description')) out.description = text(b.description, 'description', LIMITS.description);
  if (partial && has('liked')) { if (typeof b.liked !== 'boolean') throw badRequest('liked must be true or false'); out.liked = b.liked; }
  if (partial && has('artKey')) { if (b.artKey !== null && !ART_RE.test(String(b.artKey))) throw badRequest('artKey is not valid'); out.artKey = b.artKey; }
  if (partial && has('removeArt')) out.removeArt = !!b.removeArt;
  if (out.year == null && out.releaseDate) out.year = Number(out.releaseDate.slice(0, 4));
  return out;
}
// Albums without an album artist group under the first artist.
export const effectiveAlbumArtist = (t) => t.albumArtist || t.artists?.[0] || 'Unknown artist';
export const artistInput = (body) => { const b = allowKeys(v.object(body), ['name', 'description']); return { name: v.string(b.name, 'name', { min: 1, max: 200 }), description: 'description' in b ? text(b.description, 'description', 2000) : '' }; };
export const UNKNOWN_ARTIST = 'Unknown artist';

export function playlistIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), ['name', 'description']);
  const out = {};
  if (!partial || 'name' in b) out.name = v.string(b.name, 'name', { min: 1, max: 100 });
  if (!partial || 'description' in b) out.description = text(b.description, 'description', 500);
  return out;
}
export const idList = (x, name, max = LIMITS.playlistTracks) => {
  if (!Array.isArray(x) || x.length > max) throw badRequest(`${name} must be a list of at most ${max} track ids`);
  return x.map((i) => v.anyId(i, 'track id'));
};
export const profileIn = (body) => {
  const b = allowKeys(v.object(body), ['name', 'description', 'artKey', 'removeArt']);
  const out = {};
  if ('name' in b) out.name = v.string(b.name, 'name', { min: 1, max: 200 });
  if ('description' in b) out.description = text(b.description, 'description', 2000);
  if ('artKey' in b) { if (b.artKey !== null && !ART_RE.test(String(b.artKey))) throw badRequest('artKey is not valid'); out.artKey = b.artKey; }
  if ('removeArt' in b) out.removeArt = !!b.removeArt;
  return out;
};

// ---- listening events (see analytics.js for the rules) ----
export const EVENT_TYPES = ['play', 'skip', 'complete'];
export function eventIn(e) {
  const o = v.object(e, 'event');
  const eid = v.string(o.eid, 'eid', { min: 8, max: 40 });
  if (!/^[A-Za-z0-9_-]+$/.test(eid)) throw badRequest('eid is not valid');
  const type = v.enum(o.type, 'type', EVENT_TYPES);
  const trackId = v.anyId(o.trackId, 'trackId');
  const ts = new Date(v.string(o.ts, 'ts', { max: 40 }));
  if (Number.isNaN(ts.getTime())) throw badRequest('ts is not a valid time');
  const listenedMs = intIn(o.listenedMs, 'listenedMs', 0, 12 * 3600_000);
  const durationMs = intIn(o.durationMs ?? 0, 'durationMs', 0, 12 * 3600_000);
  const src = ['library', 'album', 'artist', 'playlist', 'liked', 'search', 'nebula', 'downloads', 'queue', 'other'].includes(o.src) ? o.src : 'other';
  return { eid, type, trackId, ts: ts.toISOString(), listenedMs, durationMs, src, offline: !!o.offline };
}
