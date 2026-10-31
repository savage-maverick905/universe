// Nebula's tools for Jupiter. The model can only (1) READ the real library and analytics through permission-checked tools, and
// (2) ask the BROWSER to act (play, queue, control) through `clientActions`. Every track id is verified against the real library here
// before an action is built, and the browser re-checks it. Destructive things (deleting music, clearing or deleting a playlist) are never done
// by a tool: the tool only produces a "confirm" card the person must tap.
import { badRequest } from '../../../shared/errors.js';
import { norm } from './schema.js';
import { smartMixes, similarTo, libraryHealth, tasteProfile, moodOf } from '../lib/smart.js';

const str = (n = 200, extra = {}) => ({ type: 'string', maxLength: n, ...extra });
const SORTS = ['relevance', 'mostPlayed', 'favourites', 'recentlyPlayed', 'recentlyAdded', 'random', 'title', 'album'];
const brief = (t) => ({ id: t.id, title: t.title, artist: t.artists.join(', '), album: t.album, genre: t.genre || undefined, tags: t.tags?.length ? t.tags : undefined, liked: t.liked || undefined, plays: t.playCount || undefined, minutes: t.durationMs ? Math.round(t.durationMs / 6000) / 10 : undefined });

export function makeAi(s, lib, analytics) {
  const can = (user, perm) => s.permissions.assert(user, `jupiter.${perm}`);
  const ids = (x) => (x ? [...new Set(String(x).split(',').map((i) => i.trim()).filter(Boolean))].slice(0, 100) : []);
  const filters = (a) => ({ text: a.query, artist: a.artist, album: a.album, genre: a.genre, tag: a.tag, likedOnly: a.likedOnly, sort: a.sort && a.sort !== 'relevance' ? a.sort : undefined, limit: a.limit || 25 });
  const hasFilter = (a) => !!(a.query || a.artist || a.album || a.genre || a.tag || a.likedOnly || a.playlist);

  // Turns tool arguments into real tracks: either explicit ids (verified) or library filters, or one of the person's playlists.
  async function resolve(user, a, { defaultLimit = 25 } = {}) {
    let rows = [];
    const wanted = ids(a.ids);
    if (wanted.length) {
      const all = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
      rows = wanted.map((i) => all.get(i)).filter(Boolean);
      const bad = wanted.length - rows.length;
      if (bad && !rows.length) throw badRequest('None of those track ids exist in the library. Search first and use ids from the results.');
      return { rows, ignored: bad };
    }
    if (a.playlist) { const p = await lib.findPlaylistByName(user, a.playlist); rows = await lib.select(user, { playlistId: p.id, limit: a.limit || 200 }); return { rows, ignored: 0, source: `playlist "${p.name}"` }; }
    if (a.rangeStats) return { rows: [], ignored: 0 };
    if (!hasFilter(a)) throw badRequest('Say what to use: a search word, artist, genre, tag, playlist or a list of track ids.');
    rows = await lib.select(user, { ...filters(a), limit: a.limit || defaultLimit });
    return { rows, ignored: 0 };
  }
  const notFound = (a) => `Nothing in the library matches ${[a.query, a.artist && `artist "${a.artist}"`, a.genre && `genre "${a.genre}"`, a.tag && `tag "${a.tag}"`, a.album && `album "${a.album}"`].filter(Boolean).join(', ') || 'that'}.`;

  async function mostListened(user, a, ctx) {
    const kind = a.period || 'month', tz = Number.isFinite(ctx.clientContext?.tzOffset) ? ctx.clientContext.tzOffset : 0;
    const st = await analytics.stats(user, { kind, from: a.from, to: a.to, tz, limit: a.limit || 25 });
    const all = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
    return { st, rows: st.topTracks.map((x) => all.get(x.trackId)).filter(Boolean) };
  }

  function registerTools() {
    const reg = s.aiTools?.registerApp.bind(s.aiTools, 'jupiter');
    if (!reg) return;

    reg('jupiter.libraryOverview', { parameters: { properties: {} }, handler: async (_a, { user }) => lib.overview(user) });

    reg('jupiter.searchLibrary', { parameters: { properties: { query: str(100, { description: 'Words to look for in title, artist, album, genre or tags' }), artist: str(100), album: str(100), genre: str(60), tag: str(40),
        likedOnly: { type: 'boolean' }, sort: { type: 'string', enum: SORTS }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
      handler: async (a, { user }) => {
        if (!hasFilter(a) && !a.sort) throw badRequest('Give at least one thing to search for, or a sort order.');
        const rows = await lib.select(user, filters(a));
        return { count: rows.length, tracks: rows.map(brief), note: rows.length ? undefined : notFound(a) };
      } });

    reg('jupiter.listeningStats', { parameters: { properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all', 'custom'] }, from: str(10, { description: 'YYYY-MM-DD, custom only' }), to: str(10, { description: 'YYYY-MM-DD, custom only' }), limit: { type: 'integer', minimum: 1, maximum: 25 } } },
      handler: async (a, { user, clientContext }) => {
        const tz = Number.isFinite(clientContext?.tzOffset) ? clientContext.tzOffset : 0;
        const st = await analytics.stats(user, { kind: a.period || 'month', from: a.from, to: a.to, tz, limit: a.limit || 10 });
        const all = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
        const recent = (await lib.select(user, { sort: 'recentlyPlayed', limit: 10 })).filter((t) => t.lastPlayedAt).slice(0, 8);
        return { period: a.period || 'month', range: { from: st.range.from, to: st.range.to }, totals: { plays: st.totals.plays, skips: st.totals.skips, completes: st.totals.completes, hoursListened: Math.round(st.totals.listenMs / 360000) / 10, uniqueTracks: st.totals.uniqueTracks },
          topTracks: st.topTracks.map((x) => ({ ...brief(all.get(x.trackId)), plays: x.plays })), topArtists: st.topArtists.slice(0, 8), topGenres: st.topGenres.slice(0, 5),
          recentlyPlayed: recent.map((t) => ({ ...brief(t), lastPlayedAt: t.lastPlayedAt })),
          coverage: st.coverage.hasAnyData ? { trackingSince: st.coverage.trackingSince, note: st.coverage.partial ? 'Part of this range is before listening was tracked: that part has NO DATA (it is not zero plays).' : undefined } : { note: 'No listening has been recorded yet.' } };
      } });

    reg('jupiter.nowPlaying', { parameters: { properties: {} }, handler: async (_a, { user, clientContext }) => {
      const c = clientContext?.jupiter;
      if (!c || !c.trackId) return { playing: false, note: 'Nothing is playing in Jupiter right now (or Jupiter is not open).' };
      const all = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
      const t = all.get(String(c.trackId));
      if (!t) return { playing: false, note: 'The player reports a track that is not in the library.' };
      const queue = (Array.isArray(c.queueIds) ? c.queueIds : []).slice(0, 30).map((i) => all.get(String(i))).filter(Boolean).map(brief);
      return { playing: !!c.playing, track: brief(t), positionSec: Number.isFinite(c.positionSec) ? Math.round(c.positionSec) : undefined, shuffle: !!c.shuffle, repeat: ['off', 'one', 'all'].includes(c.repeat) ? c.repeat : 'off', upNext: queue };
    } });

    reg('jupiter.play', { parameters: { properties: { ids: str(3000, { description: 'Comma-separated track ids from earlier tool results' }), query: str(100), artist: str(100), album: str(100), genre: str(60), tag: str(40), likedOnly: { type: 'boolean' },
        playlist: str(100, { description: 'Name of one of the person\'s playlists' }), sort: { type: 'string', enum: SORTS }, mostListened: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'], description: 'Play the most-listened tracks of this period' },
        mode: { type: 'string', enum: ['replace', 'next', 'append'], description: 'replace = start playing now (default), next = play after the current track, append = add to the end of the queue' }, shuffle: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      handler: async (a, ctx) => {
        await can(ctx.user, 'library.read');
        let rows, label, extra = {};
        if (a.mostListened) { const r = await mostListened(ctx.user, { period: a.mostListened, limit: a.limit || 25 }, ctx); rows = r.rows; label = `Most listened ${a.mostListened === 'all' ? 'ever' : `this ${a.mostListened}`}`; if (!r.st.coverage.hasAnyData) extra.note = 'No listening has been recorded yet, so there is no most-listened list.'; }
        else { const r = await resolve(ctx.user, a); rows = r.rows; label = r.source || [a.artist, a.genre, a.tag, a.query, a.likedOnly && 'liked'].filter(Boolean).join(' · ') || 'Selected tracks'; if (r.ignored) extra.ignoredUnknownIds = r.ignored; }
        if (!rows.length) return { played: 0, found: false, note: extra.note || notFound(a) };
        const mode = a.mode || 'replace';
        const lead = rows[0], one = rows.length === 1 ? `${lead.title} by ${lead.artists.join(', ')}` : `${label} (${rows.length} songs, starting with ${lead.title} by ${lead.artists.join(', ')})`;
        return { final: mode === 'replace' ? `Playing ${one}.` : mode === 'next' ? `${one} will play next.` : `Added ${one} to your queue.`, found: true, queued: rows.length, mode, label, first: rows.slice(0, 5).map(brief), ...extra, clientActions: [{ type: 'play', trackIds: rows.map((t) => t.id), mode, shuffle: !!a.shuffle, label }] };
      } });

    reg('jupiter.control', { parameters: { required: ['action'], properties: { action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous', 'shuffleOn', 'shuffleOff', 'repeatOff', 'repeatOne', 'repeatAll', 'seek', 'volume', 'like', 'unlike'] },
        value: { type: 'integer', minimum: 0, maximum: 36000, description: 'seconds for seek, 0-100 for volume' } } },
      handler: async (a, { user }) => {
        await can(user, 'library.read');
        if (['seek', 'volume'].includes(a.action) && a.value == null) throw badRequest(`${a.action} needs a value`);
        if (a.action === 'volume' && a.value > 100) throw badRequest('volume must be 0 to 100');
        const said = { pause: 'Paused.', resume: 'Playing.', next: 'Skipping to the next song.', previous: 'Going back.', shuffleOn: 'Shuffle is on.', shuffleOff: 'Shuffle is off.', repeatOff: 'Repeat is off.', repeatOne: 'Repeating this song.', repeatAll: 'Repeating the queue.', seek: 'Done.', volume: `Volume set to ${a.value}%.`, like: 'Added to your liked songs.', unlike: 'Removed from your liked songs.' }[a.action];
        return { ok: true, requested: a.action, final: said, clientActions: [{ type: 'control', action: a.action, ...(a.value != null ? { value: a.value } : {}) }] };
      } });

    reg('jupiter.createPlaylist', { parameters: { required: ['name'], properties: { name: str(100), description: str(300), ids: str(3000, { description: 'Comma-separated track ids' }), query: str(100), artist: str(100), genre: str(60), tag: str(40), likedOnly: { type: 'boolean' },
        sort: { type: 'string', enum: SORTS }, mostListened: { type: 'string', enum: ['week', 'month', 'year', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      handler: async (a, ctx) => {
        await can(ctx.user, 'library.write');
        let rows;
        if (a.mostListened) rows = (await mostListened(ctx.user, { period: a.mostListened, limit: a.limit || 25 }, ctx)).rows;
        else rows = (await resolve(ctx.user, a, { defaultLimit: 30 })).rows;
        if (!rows.length) return { created: false, note: `No playlist was created. ${notFound(a)}` };
        const pl = await lib.createPlaylist(ctx.user, { name: a.name.trim() || 'New playlist', description: a.description || '' }, rows.map((t) => t.id));
        return { created: true, playlist: { id: pl.id, name: pl.name, tracks: pl.trackIds.length }, sample: rows.slice(0, 5).map(brief), clientActions: [{ type: 'refresh' }, { type: 'openPlaylist', id: pl.id }] };
      } });

    reg('jupiter.addToPlaylist', { parameters: { required: ['playlist'], properties: { playlist: str(100), ids: str(3000), query: str(100), artist: str(100), genre: str(60), tag: str(40), likedOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      handler: async (a, { user }) => {
        await can(user, 'library.write');
        const p = await lib.findPlaylistByName(user, a.playlist);
        const { rows } = await resolve(user, { ...a, playlist: undefined });
        if (!rows.length) return { added: 0, note: notFound(a) };
        const have = new Set(p.trackIds), fresh = rows.filter((t) => !have.has(t.id));
        if (!fresh.length) return { added: 0, note: 'Those tracks are already in that playlist.' };
        await lib.addToPlaylist(user, p.id, fresh.map((t) => t.id));
        return { added: fresh.length, playlist: p.name, clientActions: [{ type: 'refresh' }] };
      } });

    // ---- smarter tools: taste-based recommendations, mixes, similar songs and library tidy-up ----
    reg('jupiter.recommend', { parameters: { properties: { basedOn: str(100, { description: 'Optional: a track id, or a song/artist name, to find similar music' }), mood: str(30, { description: 'Optional mood: chill, workout, focus, happy, sad' }), mix: { type: 'string', enum: ['foryou', 'rediscover', 'gems', 'repeat'], description: 'foryou = best guess for now, rediscover = forgotten favourites, gems = unplayed songs you may like, repeat = current obsessions' }, play: { type: 'boolean', description: 'true to start playing the result' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
      handler: async (a, ctx) => {
        await can(ctx.user, 'library.read');
        const all = await lib.allTracks(ctx.user); if (!all.length) return { count: 0, note: 'The library is empty.' };
        let rows, label;
        if (a.basedOn) {
          const byId = all.find((t) => t.id === a.basedOn); const seed = byId || (await lib.select(ctx.user, { text: a.basedOn, limit: 1 }))[0] || (await lib.select(ctx.user, { artist: a.basedOn, sort: 'mostPlayed', limit: 1 }))[0];
          if (!seed) return { count: 0, note: `Nothing in the library matches \"${a.basedOn}\".` };
          rows = similarTo(seed, all, { limit: a.limit || 20 }); label = `More like ${seed.title}`;
          if (!rows.length) return { count: 0, note: `Nothing else in the library is similar to ${seed.title} yet. Adding genres or tags to your songs helps.` };
        } else {
          const mixes = smartMixes(all, { seed: new Date().toISOString().slice(0, 10), size: a.limit || 25 });
          const m = a.mood ? mixes.find((x) => x.id === `mood-${moodOf(a.mood)}`) : mixes.find((x) => x.id === (a.mix || 'foryou'));
          if (!m) return { count: 0, note: a.mood ? `Not enough songs tagged or genred as \"${a.mood}\" to make a mix.` : 'Not enough listening history for that mix yet. Play and like some songs first.' };
          rows = m.tracks; label = m.title;
        }
        rows = rows.slice(0, a.limit || 25);
        const res = { count: rows.length, label, tracks: rows.slice(0, 12).map(brief) };
        if (a.play) { res.final = `Playing ${label} (${rows.length} songs).`; res.clientActions = [{ type: 'play', trackIds: rows.map((t) => t.id), mode: 'replace', shuffle: false, label }]; }
        return res;
      } });

    reg('jupiter.tasteProfile', { parameters: { properties: {} }, handler: async (_a, { user }) => {
      await can(user, 'library.read'); const all = await lib.allTracks(user), p = tasteProfile(all), top = (m) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, score]) => ({ name, score: Math.round(score * 100) / 100 }));
      return { topArtists: top(p.artist), topGenres: top(p.genre), topTags: top(p.tag), note: 'Scores are 0 to 1, relative to your favourite. Based on likes, plays, skips and recency.' };
    } });

    reg('jupiter.libraryHealth', { parameters: { properties: {} }, handler: async (_a, { user }) => { await can(user, 'library.read'); return libraryHealth(await lib.allTracks(user)); } });

    reg('jupiter.requestDelete', { parameters: { required: ['action'], properties: { action: { type: 'string', enum: ['deleteTrack', 'deletePlaylist', 'clearPlaylist'] }, trackId: str(100), playlist: str(100) } },
      handler: async (a, { user }) => {
        await can(user, a.action === 'deleteTrack' ? 'library.delete' : 'library.write');
        if (a.action === 'deleteTrack') {
          const t = await lib.ownTrack(user, a.trackId);
          return { confirmationRequired: true, note: 'Nothing was deleted. A confirmation card is shown; the person must tap Delete to remove the audio file permanently.', clientActions: [{ type: 'confirm', action: 'deleteTrack', trackId: t.id, title: t.title, artist: t.artists.join(', ') }] };
        }
        const p = await lib.findPlaylistByName(user, a.playlist || '');
        return { confirmationRequired: true, note: 'Nothing was changed. A confirmation card is shown; the person must tap to confirm. Songs themselves are never deleted by this.', clientActions: [{ type: 'confirm', action: a.action, playlistId: p.id, title: p.name }] };
      } });
  }
  return { registerTools, resolve, brief };
}
