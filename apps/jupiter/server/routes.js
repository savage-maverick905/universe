// Jupiter's HTTP API under /api/apps/jupiter. Every route: (1) checks a Universe permission first, (2) acts only on the signed-in user's
// own records, (3) takes identity from the session, never from the request, (4) rejects unknown body fields.
import { timingSafeEqual } from 'node:crypto';
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest, HttpError, notFound } from '../../../shared/errors.js';
import { reply } from '../../../http/http.js';
import { LIMITS, ART_RE, idList, playlistIn, profileIn, trackMetaIn } from './schema.js';
import { streamAudio, streamArt } from './stream.js';
import { PART_SIZE } from './library.js';

export const P = '/api/apps/jupiter';
const bool = (q, k) => q.get(k) === 'true';

export function routes({ router, s, lib, media, uploads, analytics, maintenance }) {
  const can = (user, perm) => s.permissions.assert(user, `jupiter.${perm}`);
  const route = (method, path, perm, fn, opts) => router.add(method, `${P}${path}`, async (ctx) => { await can(ctx.user, perm); return fn(ctx); }, opts);
  const cfg = () => s.config.jupiter || {};

  route('GET', '/meta', 'library.read', async ({ user }) => ({
    partSize: PART_SIZE, maxFileMb: cfg().maxFileMb || 200, libraryLimitMb: cfg().libraryLimitMb || 900, storage: media.kind, limits: LIMITS,
    can: { write: await s.permissions.can(user, 'jupiter.library.write'), delete: await s.permissions.can(user, 'jupiter.library.delete'), stats: await s.permissions.can(user, 'jupiter.stats.read'),
      maintain: await s.permissions.can(user, 'jupiter.admin.maintain'), ai: await s.permissions.can(user, 'jupiter.library.read') && await s.permissions.can(user, 'ai.use') },
  }));
  route('GET', '/library', 'library.read', ({ user }) => lib.bootstrap(user));
  route('GET', '/export', 'library.read', async ({ user }) => { const b = await lib.bootstrap(user); return { format: 'jupiter-metadata-export', note: 'Metadata only (no audio files or artwork).', exportedAt: new Date().toISOString(), ...b, tracks: b.tracks }; });

  // ---- tracks ----
  route('GET', '/tracks/:id', 'library.read', async ({ user, params }) => ({ track: lib.compact(await lib.ownTrack(user, params.id)) }));
  route('PATCH', '/tracks/:id', 'library.write', async ({ user, params, body }) => {
    const patch = trackMetaIn(body, { partial: true });
    if (patch.artKey && !(await lib.ownsArt(user, patch.artKey))) throw badRequest('That artwork does not exist in your library');
    const old = (await lib.ownTrack(user, params.id)).artKey;
    const track = await lib.updateTrack(user, params.id, patch);
    if (old && old !== track.artKey && !(await lib.artInUse(user, old))) media.commit({ remove: [`art/${old}`], message: 'Jupiter: remove replaced artwork' }).catch(() => {});
    return { track };
  });
  // Deleting a track deletes the audio file for good, so the caller must say so (?confirm=true). Removing it from a playlist never does.
  route('DELETE', '/tracks/:id', 'library.delete', async ({ user, params, query, ip }) => {
    if (!bool(query, 'confirm')) throw badRequest('Deleting a track permanently removes its audio file. Send confirm=true to proceed.', 'confirm_required');
    const { removed, track } = await lib.deleteTrack(user, params.id);
    await s.audit.record({ actorId: user.id, action: 'jupiter.track_delete', targetType: 'track', targetId: track.id, ip });
    let cleanup = 'done';
    try { await media.commit({ remove: removed, message: `Jupiter: delete track ${track.id}` }); } catch (e) { cleanup = 'pending'; s.log.error?.('Jupiter file cleanup failed:', e.message); }
    return { ok: true, removedTitle: track.title, storageCleanup: cleanup };
  });
  route('GET', '/tracks/:id/audio', 'library.read', async ({ user, params, req, res }) => streamAudio({ req, res, track: await lib.ownTrack(user, params.id), media }), { raw: true });
  route('GET', '/art/:key', 'library.read', async ({ user, params, res }) => {
    if (!ART_RE.test(params.key) || !(await lib.ownsArt(user, params.key))) throw notFound('Artwork not found');
    return streamArt({ res, media, key: params.key });
  });

  // ---- artwork replacement (small image in the request body) ----
  async function applyArt(user, kind, id, key) {
    if (kind === 'track') { const old = (await lib.ownTrack(user, id)).artKey; const track = await lib.updateTrack(user, id, { artKey: key }); await dropIfUnused(user, old); return { track }; }
    const old = await lib.profileArtKey(user, kind, id); await lib.setProfile(user, kind, id, { artKey: key }); await dropIfUnused(user, old);
    return { ok: true, artKey: key };
  }
  async function dropIfUnused(user, old) { if (old && !(await lib.artInUse(user, old))) await media.commit({ remove: [`art/${old}`], message: 'Jupiter: remove replaced artwork' }).catch(() => {}); }

  // ---- albums and artists ----
  route('GET', '/albums/:id', 'library.read', async ({ user, params }) => { const a = (await lib.albumsOf(user)).get(params.id); if (!a) throw notFound('Album not found'); return { id: a.id, title: a.title, albumArtist: a.albumArtist, trackIds: a.tracks.map((t) => t.id) }; });
  route('PATCH', '/albums/:id', 'library.write', async ({ user, params, body }) => {
    const p = profileIn(body); if (p.artKey && !(await lib.ownsArt(user, p.artKey))) throw badRequest('That artwork does not exist in your library');
    const old = p.removeArt || 'artKey' in p ? await lib.profileArtKey(user, 'album', params.id) : null;
    const saved = await lib.setProfile(user, 'album', params.id, p); await dropIfUnused(user, old && old !== saved.artKey ? old : null); return { album: { id: saved.id, artKey: saved.artKey || null, description: saved.description || '' } };
  });
  route('POST', '/albums/:id/rename', 'library.write', async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['title', 'albumArtist']);
    const n = await lib.renameAlbum(user, params.id, { title: 'title' in b ? v.string(b.title, 'title', { min: 1, max: 200 }) : undefined, albumArtist: 'albumArtist' in b ? v.string(b.albumArtist, 'albumArtist', { max: 200 }) : undefined });
    return { ok: true, tracksChanged: n };
  });
  route('PATCH', '/artists/:id', 'library.write', async ({ user, params, body }) => {
    const p = profileIn(body); if (p.artKey && !(await lib.ownsArt(user, p.artKey))) throw badRequest('That artwork does not exist in your library');
    const old = p.removeArt || 'artKey' in p ? await lib.profileArtKey(user, 'artist', params.id) : null;
    const saved = await lib.setProfile(user, 'artist', params.id, p); await dropIfUnused(user, old && old !== saved.artKey ? old : null); return { artist: { id: saved.id, artKey: saved.artKey || null, description: saved.description || '' } };
  });
  for (const [kind, plural] of [['track', 'tracks'], ['album', 'albums'], ['artist', 'artists']]) {
    route('PUT', `/${plural}/:id/artwork`, 'library.write', async ({ user, params, req }) => {
      if (kind === 'track') await lib.ownTrack(user, params.id); else if (kind === 'album' ? !(await lib.albumsOf(user)).get(params.id) : !(await lib.artistsOf(user)).get(params.id)) throw notFound(`${kind} not found`);
      const key = await uploads.addArtwork(user, req);
      try { return await applyArt(user, kind, params.id, key); } catch (e) { media.commit({ remove: [`art/${key}`], message: 'Jupiter: undo artwork' }).catch(() => {}); throw e; }
    }, { raw: true });
  }

  // ---- uploads ----
  route('POST', '/uploads/start', 'library.write', async ({ user, body }) => {
    const b = allowKeys(v.object(body), ['name', 'size', 'fingerprint']);
    return uploads.start(user, { name: v.string(b.name ?? '', 'name', { max: 300 }), size: b.size, fingerprint: b.fingerprint });
  });
  route('PUT', '/uploads/:uploadId/parts/:index', 'library.write', ({ user, params, req }) => uploads.putPart(user, params.uploadId, Number(params.index), req), { raw: true });
  route('PUT', '/uploads/:uploadId/art', 'library.write', ({ user, params, req }) => uploads.putArt(user, params.uploadId, req), { raw: true });
  route('POST', '/uploads/:uploadId/finish', 'library.write', async ({ user, params, body, ip }) => {
    const r = await uploads.finish(user, params.uploadId, body);
    await s.audit.record({ actorId: user.id, action: 'jupiter.track_add', targetType: 'track', targetId: r.track.id, ip });
    return reply(201, r);
  }, { bodyLimit: 64 * 1024 });

  // ---- playlists ----
  route('POST', '/playlists', 'library.write', async ({ user, body }) => {
    const b = v.object(body); const meta = playlistIn({ name: b.name, ...('description' in b ? { description: b.description } : {}) });
    allowKeys(b, ['name', 'description', 'trackIds']);
    return reply(201, { playlist: await lib.createPlaylist(user, meta, 'trackIds' in b ? idList(b.trackIds, 'trackIds') : []) });
  });
  route('PATCH', '/playlists/:id', 'library.write', async ({ user, params, body }) => ({ playlist: await lib.updatePlaylist(user, params.id, playlistIn(body, { partial: true })) }));
  // Deleting a playlist deletes only the list. The songs stay in the library.
  route('DELETE', '/playlists/:id', 'library.write', ({ user, params, query }) => {
    if (!bool(query, 'confirm')) throw badRequest('Send confirm=true to delete this playlist. Its songs stay in your library.', 'confirm_required');
    return lib.deletePlaylist(user, params.id);
  });
  route('PUT', '/playlists/:id/tracks', 'library.write', async ({ user, params, body }) => { allowKeys(v.object(body), ['trackIds']); return { playlist: await lib.setPlaylistTracks(user, params.id, idList(body.trackIds, 'trackIds')) }; });
  route('POST', '/playlists/:id/tracks', 'library.write', async ({ user, params, body }) => { allowKeys(v.object(body), ['trackIds']); return { playlist: await lib.addToPlaylist(user, params.id, idList(body.trackIds, 'trackIds', 500)) }; });

  // ---- listening history ----
  route('POST', '/events', 'library.read', async ({ user, body }) => { allowKeys(v.object(body), ['events']); return analytics.ingest(user, body.events); }, { bodyLimit: 64 * 1024 });
  route('GET', '/stats', 'stats.read', ({ user, query }) => {
    const tz = Number(query.get('tz') || 0); if (!Number.isInteger(tz) || tz < -840 || tz > 840) throw badRequest('tz must be minutes from UTC');
    const limit = Number(query.get('limit') || 10); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badRequest('limit must be 1 to 50');
    return analytics.stats(user, { kind: query.get('range') || 'month', from: query.get('from'), to: query.get('to'), tz, limit });
  });

  // ---- dashboard widgets (database only: cheap) ----
  route('GET', '/widget/summary', 'library.read', async ({ user }) => { const t = await lib.allTracks(user), pl = await lib.cols.playlists.count({ ownerId: user.id });
    return { stats: [{ label: 'Tracks', value: t.length }, { label: 'Playlists', value: pl }, { label: 'Liked', value: t.filter((x) => x.liked).length }, { label: 'Plays', value: t.reduce((n, x) => n + (x.playCount || 0), 0) }] }; });
  route('GET', '/widget/recent', 'library.read', async ({ user }) => ({ items: (await lib.select(user, { sort: 'recentlyPlayed', limit: 50 })).filter((t) => t.lastPlayedAt).slice(0, 6).map((t) => ({ title: t.title, subtitle: t.artists.join(', ') })) }));

  // ---- storage upkeep ----
  route('GET', '/maintenance/status', 'admin.maintain', async () => ({ storage: media.kind, branch: media.branch || null, head: await media.head(), schedule: 'weekly (Sunday 03:00 UTC) when CRON_SECRET is set and the Vercel cron in vercel.json is active', cronConfigured: !!cfg().cronSecret }));
  route('POST', '/maintenance/rebuild-history', 'admin.maintain', async ({ user, query, ip }) => {
    if (!bool(query, 'confirm')) throw badRequest('Send confirm=true. This squashes the music branch history; all current files are kept.', 'confirm_required');
    const r = await maintenance.rebuild({ force: true }); await s.audit.record({ actorId: user.id, action: 'jupiter.history_rebuild', meta: { result: r.skipped || 'done' }, ip }); return r;
  });
  route('GET', '/maintenance/orphans', 'admin.maintain', () => maintenance.orphanReport());
  // Called by Vercel Cron. Not a signed-in user: it must present CRON_SECRET (Vercel sends it as a Bearer token).
  router.add('GET', `${P}/maintenance/weekly`, async ({ req }) => {
    const want = cfg().cronSecret; if (!want) throw notFound();
    const got = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized', 'unauthorized');
    return maintenance.rebuild({ force: false });
  }, { auth: false });
}
