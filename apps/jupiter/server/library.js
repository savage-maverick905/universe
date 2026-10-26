// Jupiter's library: tracks, albums/artists (derived), playlists. Everything is scoped to the signed-in user (ownerId).
// Audio bytes live in the media store (see media.js); only metadata and references live in the Universe database.
import { newId, nowIso } from '../../../shared/ids.js';
import { badRequest, conflict, notFound } from '../../../shared/errors.js';
import { ART_RE, LIMITS, UNKNOWN_ARTIST, albumId, norm } from './schema.js';

export const PART_SIZE = 3 * 1024 * 1024; // every stored part except a track's last is exactly this size; also keeps each response under Vercel's 4.5 MB limit

export function makeLibrary(s, media) {
  const col = (n, o) => s.storage.collection(`jupiter_${n}`, o);
  const cols = { tracks: col('tracks', { indexes: ['ownerId'] }), playlists: col('playlists', { indexes: ['ownerId'] }), albums: col('albums', { indexes: ['ownerId'] }), artists: col('artists', { indexes: ['ownerId'] }) };
  const mine = (c, user, extra = {}) => c.find({ where: { ownerId: user.id, ...extra }, limit: 10000 });

  // Artists are real records the person creates. A track stores only their ids; names are filled in when reading. No artist = Unknown artist.
  const nameMap = async (user) => new Map((await mine(cols.artists, user)).map((a) => [a.id, a.name]));
  const decorate = (t, names) => { const n = (t.artistIds || []).map((i) => names.get(i)).filter(Boolean); return { ...t, artists: n.length ? n : [UNKNOWN_ARTIST] }; };
  const albumKeyOf = (t) => t.albumArtist || t.artistIds?.[0] || '';
  const albumArtistOf = (t) => t.albumArtist || (t.artistIds?.length ? t.artists[0] : UNKNOWN_ARTIST);
  async function checkArtists(user, ids) { if (!ids?.length) return; const have = new Set((await mine(cols.artists, user)).map((a) => a.id)); for (const i of ids) if (!have.has(i)) throw badRequest('One of those artists does not exist. Create the artist first.'); }
  const compact = (t) => ({ id: t.id, title: t.title, artists: t.artists, artistIds: t.artistIds || [], album: t.album, albumArtist: t.albumArtist || '', trackNo: t.trackNo, discNo: t.discNo, durationMs: t.durationMs, year: t.year, releaseDate: t.releaseDate,
    genre: t.genre, tags: t.tags, description: t.description, liked: !!t.liked, artKey: t.artKey || null, size: t.size, kind: t.kind, playCount: t.playCount || 0, skipCount: t.skipCount || 0, listenMs: t.listenMs || 0,
    lastPlayedAt: t.lastPlayedAt || null, addedAt: t.createdAt, hash: t.contentHash.slice(0, 12) });

  async function ownTrack(user, id) { const t = id ? await cols.tracks.get(id) : null; if (!t || t.ownerId !== user.id) throw notFound('Track not found'); return decorate(t, await nameMap(user)); }
  async function ownPlaylist(user, id) { const p = id ? await cols.playlists.get(id) : null; if (!p || p.ownerId !== user.id) throw notFound('Playlist not found'); return p; }
  async function allTracks(user) { const names = await nameMap(user); return (await mine(cols.tracks, user)).map((t) => decorate(t, names)); }

  async function bootstrap(user) {
    const [tracks, playlists, albums, artists] = await Promise.all([allTracks(user), mine(cols.playlists, user), mine(cols.albums, user), mine(cols.artists, user)]);
    const used = tracks.reduce((n, t) => n + (t.size || 0), 0);
    return {
      tracks: tracks.map((t) => ({ ...compact(t), albumId: albumId(user.id, albumKeyOf(t), t.album), mime: t.mime })), used,
      playlists: playlists.map(publicPlaylist),
      albums: albums.map((a) => ({ id: a.id, title: a.title, albumArtist: a.albumArtist, artKey: a.artKey || null, description: a.description || '' })),
      artists: artists.map((a) => ({ id: a.id, name: a.name, artKey: a.artKey || null, description: a.description || '' })).sort((x, y) => x.name.localeCompare(y.name)),
    };
  }
  const publicPlaylist = (p) => ({ id: p.id, name: p.name, description: p.description || '', trackIds: p.trackIds, createdAt: p.createdAt, updatedAt: p.updatedAt });

  // ---------- tracks ----------
  async function createTrack(user, meta, file, artKey = null, id = newId('trk')) {
    const doc = { id, ownerId: user.id, schemaVersion: 1, ...meta, albumArtist: meta.albumArtist || '', size: file.size, kind: file.kind, mime: file.mime, partSize: PART_SIZE, parts: file.parts, contentHash: file.contentHash,
      originalName: file.originalName || '', artKey, liked: false, playCount: 0, skipCount: 0, listenMs: 0, lastPlayedAt: null };
    await checkArtists(user, meta.artistIds);
    return s.storage.transaction(async () => {
      const dup = await cols.tracks.find({ where: { ownerId: user.id, contentHash: file.contentHash }, limit: 1 });
      if (dup.length) throw conflict(`This file is already in your library as "${dup[0].title}".`, 'duplicate');
      return compact(decorate(await cols.tracks.insert(doc), await nameMap(user)));
    });
  }
  async function findDuplicate(user, contentHash) { const d = await cols.tracks.find({ where: { ownerId: user.id, contentHash }, limit: 1 }); return d[0] ? { id: d[0].id, title: d[0].title } : null; }

  async function updateTrack(user, id, patch) {
    const t = await ownTrack(user, id);
    const { removeArt, ...rest } = patch;
    if (removeArt) rest.artKey = null;
    if (rest.artistIds) await checkArtists(user, rest.artistIds);
    if ('liked' in rest) rest.likedAt = rest.liked ? nowIso() : null;
    return compact(decorate(await cols.tracks.update(t.id, rest), await nameMap(user)));
  }
  // Removes track records and their place in every playlist in ONE transaction. Returns the media paths to delete afterwards.
  async function deleteTracks(user, ids) {
    const set = new Set(ids), doomed = (await allTracks(user)).filter((t) => set.has(t.id));
    const paths = doomed.flatMap((t) => t.parts.map((_, i) => partPath(t.id, i)));
    await s.storage.transaction(async () => {
      for (const p of await mine(cols.playlists, user)) { const keep = p.trackIds.filter((x) => !set.has(x)); if (keep.length !== p.trackIds.length) await cols.playlists.update(p.id, { trackIds: keep }); }
      for (const t of doomed) await cols.tracks.delete(t.id);
    });
    const art = []; for (const k of new Set(doomed.map((t) => t.artKey).filter(Boolean))) if (!(await artInUse(user, k))) art.push(`art/${k}`);
    return { removed: [...paths, ...art], tracks: doomed.map(compact) };
  }
  async function deleteTrack(user, id) { await ownTrack(user, id); const r = await deleteTracks(user, [id]); return { removed: r.removed, track: r.tracks[0] }; }
  const partPath = (trackId, i) => `tracks/${trackId}/${String(i).padStart(4, '0')}.part`;

  // ---------- artwork bookkeeping ----------
  async function artInUse(user, artKey, exceptTrackId = null) {
    for (const t of await mine(cols.tracks, user)) if (t.artKey === artKey && t.id !== exceptTrackId) return true;
    for (const c of [cols.albums, cols.artists]) for (const d of await mine(c, user)) if (d.artKey === artKey) return true;
    return false;
  }
  async function ownsArt(user, artKey) { return ART_RE.test(artKey) && artInUse(user, artKey); }

  // ---------- album and artist profiles (created only when someone edits them) ----------
  async function albumsOf(user) {
    const tracks = await allTracks(user), map = new Map();
    for (const t of tracks) {
      const id = albumId(user.id, albumKeyOf(t), t.album);
      const a = map.get(id) || { id, title: t.album, albumArtist: albumArtistOf(t), tracks: [] }; a.tracks.push(t); map.set(id, a);
    }
    return map;
  }
  async function artistsOf(user) {
    const tracks = await allTracks(user), map = new Map();
    for (const a of await mine(cols.artists, user)) map.set(a.id, { id: a.id, name: a.name, tracks: [] });
    for (const t of tracks) for (const id of t.artistIds || []) map.get(id)?.tracks.push(t);
    return map;
  }
  async function setProfile(user, kind, id, patch) {
    const { removeArt, ...rest } = patch; if (removeArt) rest.artKey = null;
    if (kind === 'artist') return updateArtist(user, id, rest);
    const known = (await albumsOf(user)).get(id); if (!known) throw notFound('Album not found');
    const cur = await cols.albums.get(id);
    return cur ? cols.albums.update(id, rest) : cols.albums.insert({ id, ownerId: user.id, schemaVersion: 1, title: known.title, albumArtist: known.albumArtist, artKey: null, description: '', ...rest });
  }
  // ---------- artists: created and removed on purpose, never auto-created from uploads ----------
  async function createArtist(user, { name, description = '' }) {
    if (norm(name) === norm(UNKNOWN_ARTIST)) throw badRequest('"Unknown artist" is built in. Songs without an artist are listed there already.');
    if ((await mine(cols.artists, user)).some((a) => norm(a.name) === norm(name))) throw conflict(`You already have an artist called "${name}".`, 'duplicate');
    return cols.artists.insert({ id: newId('art'), ownerId: user.id, schemaVersion: 1, name, description, artKey: null });
  }
  async function updateArtist(user, id, patch) {
    const a = id ? await cols.artists.get(id) : null; if (!a || a.ownerId !== user.id) throw notFound('Artist not found');
    if (patch.name && norm(patch.name) !== norm(a.name)) { if (norm(patch.name) === norm(UNKNOWN_ARTIST) || (await mine(cols.artists, user)).some((x) => x.id !== id && norm(x.name) === norm(patch.name))) throw conflict(`You already have an artist called "${patch.name}".`, 'duplicate'); }
    return cols.artists.update(id, patch);
  }
  // keep: songs stay and lose this artist (they fall back to Unknown artist if it was their only one).
  // delete: songs where this is the ONLY artist are deleted; songs shared with other artists are kept.
  async function deleteArtist(user, id, { deleteSongs = false } = {}) {
    const a = id ? await cols.artists.get(id) : null; if (!a || a.ownerId !== user.id) throw notFound('Artist not found');
    const linked = (await allTracks(user)).filter((t) => (t.artistIds || []).includes(id));
    const doomed = deleteSongs ? linked.filter((t) => t.artistIds.length === 1) : [];
    await s.storage.transaction(async () => { for (const t of linked) if (!doomed.includes(t)) await cols.tracks.update(t.id, { artistIds: t.artistIds.filter((x) => x !== id) }); await cols.artists.delete(id); });
    const r = doomed.length ? await deleteTracks(user, doomed.map((t) => t.id)) : { removed: [], tracks: [] };
    return { removed: r.removed, deletedSongs: doomed.length, keptSongs: linked.length - doomed.length, artKey: a.artKey };
  }
  async function deleteAlbum(user, id, { deleteSongs = false } = {}) {
    const al = (await albumsOf(user)).get(id); if (!al) throw notFound('Album not found');
    const prof = await cols.albums.get(id);
    let r = { removed: [], tracks: [] };
    if (deleteSongs) r = await deleteTracks(user, al.tracks.map((t) => t.id));
    else await s.storage.transaction(async () => { for (const t of al.tracks) await cols.tracks.update(t.id, { album: 'Unknown album' }); });
    if (prof) await cols.albums.delete(id);
    return { removed: r.removed, deletedSongs: r.tracks.length, keptSongs: deleteSongs ? 0 : al.tracks.length, artKey: prof?.artKey || null };
  }
  async function profileArtKey(user, kind, id) { const d = await (kind === 'album' ? cols.albums : cols.artists).get(id); return d && d.ownerId === user.id ? d.artKey || null : null; }

  // ---------- renaming an album or artist = editing the tracks that carry the name ----------
  async function renameAlbum(user, id, { title, albumArtist }) {
    const a = (await albumsOf(user)).get(id); if (!a) throw notFound('Album not found');
    await s.storage.transaction(async () => { for (const t of a.tracks) await cols.tracks.update(t.id, { ...(title ? { album: title } : {}), ...(albumArtist != null ? { albumArtist } : {}) }); });
    return a.tracks.length;
  }

  // ---------- playlists ----------
  async function createPlaylist(user, { name, description = '' }, trackIds = []) {
    const known = new Set((await allTracks(user)).map((t) => t.id));
    const ids = trackIds.filter((i) => known.has(i));
    if (ids.length > LIMITS.playlistTracks) throw badRequest(`A playlist can hold at most ${LIMITS.playlistTracks} tracks`);
    const existing = new Set((await mine(cols.playlists, user)).map((p) => norm(p.name)));
    let n = name, i = 2; while (existing.has(norm(n))) n = `${name} (${i++})`;
    return publicPlaylist(await cols.playlists.insert({ id: newId('pl'), ownerId: user.id, schemaVersion: 1, name: n, description, trackIds: ids }));
  }
  async function updatePlaylist(user, id, patch) { const p = await ownPlaylist(user, id); return publicPlaylist(await cols.playlists.update(p.id, patch)); }
  // Deleting a playlist never touches audio: it only removes the list.
  async function deletePlaylist(user, id) { const p = await ownPlaylist(user, id); await cols.playlists.delete(p.id); return { ok: true, name: p.name, tracksKept: p.trackIds.length }; }
  async function setPlaylistTracks(user, id, trackIds) {
    const p = await ownPlaylist(user, id);
    const known = new Set((await allTracks(user)).map((t) => t.id));
    for (const i of trackIds) if (!known.has(i)) throw badRequest('One of those tracks is not in your library');
    if (trackIds.length > LIMITS.playlistTracks) throw badRequest(`A playlist can hold at most ${LIMITS.playlistTracks} tracks`);
    return publicPlaylist(await cols.playlists.update(p.id, { trackIds }));
  }
  async function addToPlaylist(user, id, trackIds) {
    const p = await ownPlaylist(user, id);
    return setPlaylistTracks(user, id, [...p.trackIds, ...trackIds]);
  }
  async function findPlaylistByName(user, name) {
    const q = norm(name); const all = await mine(cols.playlists, user);
    const exact = all.filter((p) => norm(p.name) === q); if (exact.length === 1) return exact[0];
    const part = all.filter((p) => norm(p.name).includes(q)); if (part.length === 1) return part[0];
    throw badRequest(part.length || exact.length ? `More than one playlist matches "${name}": ${[...exact, ...part].map((p) => p.name).slice(0, 5).join(', ')}` : `No playlist called "${name}"`);
  }

  // ---------- searching (used by the screens' API and by Nebula's tools) ----------
  const tokens = (q) => norm(q).split(' ').filter(Boolean);
  const hay = (t) => norm([t.title, t.artists.join(' '), t.album, t.albumArtist, t.genre, (t.tags || []).join(' ')].join(' '));
  const fuzzyEq = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a) || a.replace(/s$/, '') === b.replace(/s$/, '')); };
  async function select(user, f = {}) {
    let rows = await allTracks(user);
    if (f.text) { const ts = tokens(f.text); rows = rows.filter((t) => { const h = hay(t); return ts.every((x) => h.includes(x)); }); }
    if (f.artist) rows = rows.filter((t) => t.artists.some((a) => fuzzyEq(a, f.artist) || norm(a).includes(norm(f.artist))) || fuzzyEq(t.albumArtist, f.artist));
    if (f.album) rows = rows.filter((t) => norm(t.album).includes(norm(f.album)));
    if (f.genre) rows = rows.filter((t) => fuzzyEq(t.genre, f.genre) || norm(t.genre).includes(norm(f.genre)));
    if (f.tag) rows = rows.filter((t) => (t.tags || []).some((x) => fuzzyEq(x, f.tag)));
    if (f.likedOnly) rows = rows.filter((t) => t.liked);
    if (f.playlistId) { const p = await ownPlaylist(user, f.playlistId); const set = new Map(rows.map((t) => [t.id, t])); rows = p.trackIds.map((i) => set.get(i)).filter(Boolean); }
    const sorts = {
      mostPlayed: (a, b) => (b.playCount || 0) - (a.playCount || 0) || (b.listenMs || 0) - (a.listenMs || 0),
      favourites: (a, b) => (b.liked ? 1 : 0) - (a.liked ? 1 : 0) || (b.playCount || 0) - (a.playCount || 0),
      recentlyPlayed: (a, b) => String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')),
      recentlyAdded: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
      title: (a, b) => a.title.localeCompare(b.title),
      album: (a, b) => a.album.localeCompare(b.album) || (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0),
    };
    if (f.sort === 'random') rows = rows.map((t) => [Math.random(), t]).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
    else if (sorts[f.sort]) rows = [...rows].sort(sorts[f.sort]);
    return rows.slice(0, Math.min(f.limit || 50, 500));
  }
  const overview = async (user) => {
    const tracks = await allTracks(user), count = (get) => { const m = new Map(); for (const t of tracks) for (const k of [].concat(get(t)).filter(Boolean)) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
    return { tracks: tracks.length, liked: tracks.filter((t) => t.liked).length, genres: count((t) => t.genre).slice(0, 30).map(([name, n]) => ({ name, tracks: n })),
      tags: count((t) => t.tags).slice(0, 40).map(([name, n]) => ({ name, tracks: n })), artists: count((t) => t.artists).slice(0, 60).map(([name, n]) => ({ name, tracks: n })),
      playlists: (await mine(cols.playlists, user)).map((p) => ({ name: p.name, tracks: p.trackIds.length })) };
  };

  return { cols, compact, ownTrack, ownPlaylist, allTracks, bootstrap, createTrack, findDuplicate, updateTrack, deleteTrack, partPath, artInUse, ownsArt, albumsOf, artistsOf, setProfile, profileArtKey, renameAlbum,
    deleteTracks, createArtist, updateArtist, deleteArtist, deleteAlbum, nameMap, createPlaylist, updatePlaylist, deletePlaylist, setPlaylistTracks, addToPlaylist, findPlaylistByName, select, overview, publicPlaylist };
}
