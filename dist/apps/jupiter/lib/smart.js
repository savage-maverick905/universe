// Jupiter's taste engine. Pure functions (no DOM, no server), used by the Home mixes in the browser and by Nebula's tools on the server.
// It learns from what you actually do: likes, full plays, skips, listening time and how recently you heard a song. Nothing leaves your library.
const DAY = 864e5;
const lc = (s) => String(s || '').toLowerCase().trim();
const days = (iso, now) => (iso ? Math.max(0, (now - Date.parse(iso)) / DAY) : Infinity);

// How much you like one song: roughly -1 (you skip it) to 3+ (you love it).
export function affinity(t, now = Date.now()) {
  const plays = t.playCount || 0, skips = t.skipCount || 0, n = plays + skips;
  const completion = n ? plays / n : 0.5;                      // unknown = neutral
  const depth = Math.min(1, Math.log1p(plays) / Math.log(12));  // diminishing returns on plays
  const seen = days(t.lastPlayedAt, now);
  const recent = seen === Infinity ? 0 : Math.exp(-seen / 45);  // heard in the last weeks
  return (t.liked ? 1.2 : 0) + depth * 1.2 + (completion - 0.5) * 1.2 + recent * 0.3 - (skips >= 3 && skips > plays * 2 ? 0.8 : 0);
}

// What you gravitate to: weights per artist, genre and tag, built from the songs you rate highly.
export function tasteProfile(tracks, now = Date.now()) {
  const artist = new Map(), genre = new Map(), tag = new Map();
  const add = (m, k, w) => { k = lc(k); if (k && k !== 'unknown artist') m.set(k, (m.get(k) || 0) + w); };
  for (const t of tracks) {
    const w = Math.max(0, affinity(t, now)); if (!w) continue;
    for (const a of t.artists || []) add(artist, a, w); add(genre, t.genre, w); for (const x of t.tags || []) add(tag, x, w * 0.6);
  }
  const norm = (m) => { const top = Math.max(0, ...m.values()) || 1; for (const [k, v] of m) m.set(k, v / top); return m; };
  return { artist: norm(artist), genre: norm(genre), tag: norm(tag) };
}
const taste = (t, p) => Math.max(0, ...(t.artists || []).map((a) => p.artist.get(lc(a)) || 0)) * 0.6 + (p.genre.get(lc(t.genre)) || 0) * 0.3 + Math.max(0, ...(t.tags || []).map((x) => p.tag.get(lc(x)) || 0)) * 0.2;

// Seeded shuffle so a "daily" mix is stable for the day but different tomorrow.
export function rng(seed) { let s = 2166136261; for (const c of String(seed)) { s ^= c.charCodeAt(0); s = Math.imul(s, 16777619); } return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Stops one artist taking over a mix: at most `cap` in a row-weighted pass, keeping score order otherwise.
function spread(list, cap) { const seen = new Map(), out = [], rest = []; for (const t of list) { const k = lc(t.artists?.[0]); if ((seen.get(k) || 0) < cap) { seen.set(k, (seen.get(k) || 0) + 1); out.push(t); } else rest.push(t); } return [...out, ...rest]; }

// Moods that need no audio analysis: derived from your own tags/genres/titles.
const MOODS = {
  chill: /chill|calm|relax|lofi|lo-fi|ambient|acoustic|sleep|soft|slow|jazz|soul|r&b|rnb/, workout: /workout|gym|run|hype|energy|dance|edm|trap|drill|rock|metal|pump|party|afro|amapiano/,
  focus: /focus|study|work|instrumental|classical|piano|ambient|lofi|lo-fi/, happy: /happy|summer|feel|joy|pop|party|reggae|dancehall|afro|highlife/, sad: /sad|heartbreak|cry|alone|blue|melanchol|emo|ballad/,
};
export const moodOf = (name) => Object.keys(MOODS).find((k) => k === lc(name) || lc(name).includes(k));

export function smartMixes(tracks, { now = Date.now(), seed = new Date(now).toDateString(), size = 40 } = {}) {
  if (!tracks.length) return [];
  const p = tasteProfile(tracks, now), rand = rng(seed);
  const scored = tracks.map((t) => ({ t, a: affinity(t, now), k: taste(t, p), seen: days(t.lastPlayedAt, now) }));
  const pick = (rows, n = size, cap = 3) => spread(rows.map((r) => r.t), cap).slice(0, n);
  const jitter = (r, amt) => r.a + r.k + rand() * amt;
  const out = [];
  // 1. For You: what you love, with a little room for songs you have under-played.
  out.push({ id: 'foryou', title: 'For You', sub: 'Built from what you really play', cls: 'm1', shuffle: true, tracks: pick([...scored].sort((x, y) => jitter(y, 0.9) - jitter(x, 0.9))) });
  // 2. Rediscover: songs you used to love but have not heard in a while.
  out.push({ id: 'rediscover', title: 'Rediscover', sub: 'Old favourites you have missed', cls: 'm3', shuffle: true, tracks: pick(scored.filter((r) => r.seen > 30 && (r.t.liked || (r.t.playCount || 0) >= 2)).sort((x, y) => y.a + rand() * 0.5 - (x.a + rand() * 0.5))) });
  // 3. Hidden gems: in your library, never or barely played, but close to your taste.
  out.push({ id: 'gems', title: 'Hidden Gems', sub: 'Songs you own but barely played', cls: 'm2', shuffle: true, tracks: pick(scored.filter((r) => (r.t.playCount || 0) <= 1 && (r.t.skipCount || 0) === 0).sort((x, y) => y.k + rand() * 0.4 - (x.k + rand() * 0.4))) });
  // 4. On repeat: your current obsessions (heavy plays in the last 3 weeks).
  out.push({ id: 'repeat', title: 'On Repeat', sub: 'What you keep coming back to', cls: 'm4', shuffle: false, tracks: pick(scored.filter((r) => r.seen < 21 && (r.t.playCount || 0) >= 2).sort((x, y) => (y.t.playCount || 0) - (x.t.playCount || 0)), 30) });
  // 5. One mix per top artist ("More like ...") and per strongest mood found in your own tags.
  const topArtists = [...p.artist].sort((a, b) => b[1] - a[1]).slice(0, 2);
  topArtists.forEach(([name], i) => { const first = tracks.find((t) => (t.artists || []).some((a) => lc(a) === name)); const who = first?.artists.find((a) => lc(a) === name) || name;
    const rows = scored.filter((r) => (r.t.artists || []).some((a) => lc(a) === name) || ((r.t.genre && r.t.genre === first?.genre) && r.k > 0.4)).sort((x, y) => jitter(y, 0.6) - jitter(x, 0.6));
    out.push({ id: `artist${i}`, title: `More ${who}`, sub: `${who} and similar`, cls: ['m2', 'm3'][i % 2], shuffle: true, tracks: pick(rows) }); });
  for (const [mood, re] of Object.entries(MOODS)) { const rows = scored.filter((r) => re.test(lc([r.t.genre, ...(r.t.tags || []), r.t.title].join(' '))));
    if (rows.length >= 4) out.push({ id: `mood-${mood}`, title: mood[0].toUpperCase() + mood.slice(1), sub: 'From your own tags and genres', cls: 'm1', shuffle: true, tracks: pick(rows.sort((x, y) => jitter(y, 0.6) - jitter(x, 0.6))) }); }
  return out.filter((m) => m.tracks.length >= 3);
}

// Songs that go with `seed` (a track): same artist/album/genre/tags, weighted by your taste. Used for autoplay "keep it going".
export function similarTo(seed, tracks, { now = Date.now(), limit = 20, exclude = new Set() } = {}) {
  const p = tasteProfile(tracks, now), sa = new Set((seed.artists || []).map(lc)), st = new Set((seed.tags || []).map(lc));
  return tracks.filter((t) => t.id !== seed.id && !exclude.has(t.id)).map((t) => {
    let s = 0; if ((t.artists || []).some((a) => sa.has(lc(a)))) s += 3; if (seed.album && t.album === seed.album && lc(t.album) !== 'unknown album') s += 1.5;
    if (seed.genre && lc(t.genre) === lc(seed.genre)) s += 1.5; s += (t.tags || []).filter((x) => st.has(lc(x))).length;
    if (seed.year && t.year && Math.abs(seed.year - t.year) <= 3) s += 0.4; return { t, s: s + taste(t, p) * 0.5 + affinity(t, now) * 0.4 };
  }).filter((r) => r.s > 1).sort((a, b) => b.s - a.s).slice(0, limit).map((r) => r.t);
}

// Library housekeeping: what is incomplete or likely duplicated, so Nebula can offer to tidy it.
export function libraryHealth(tracks) {
  const key = (t) => `${lc(t.title).replace(/\(.*?\)|\[.*?\]|feat\.?.*$/g, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${lc(t.artists?.[0])}`;
  const groups = new Map(); for (const t of tracks) { const k = key(t); if (!k.startsWith('|')) (groups.get(k) || groups.set(k, []).get(k)).push(t); }
  const b = (t) => ({ id: t.id, title: t.title, artist: (t.artists || []).join(', ') });
  return { total: tracks.length,
    noArtist: tracks.filter((t) => !(t.artistIds || []).length).slice(0, 25).map(b), noAlbum: tracks.filter((t) => !t.album || /^unknown album$/i.test(t.album)).slice(0, 25).map(b),
    noGenre: tracks.filter((t) => !t.genre).slice(0, 25).map(b), noArt: tracks.filter((t) => !t.artKey).slice(0, 25).map(b),
    counts: { noArtist: tracks.filter((t) => !(t.artistIds || []).length).length, noAlbum: tracks.filter((t) => !t.album || /^unknown album$/i.test(t.album)).length, noGenre: tracks.filter((t) => !t.genre).length, noArt: tracks.filter((t) => !t.artKey).length, neverPlayed: tracks.filter((t) => !t.playCount && !t.skipCount).length },
    possibleDuplicates: [...groups.values()].filter((g) => g.length > 1).slice(0, 15).map((g) => g.map(b)) };
}
