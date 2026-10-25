// Listening analytics.
//
// WHAT IS RECORDED (one event per "listen", i.e. one stretch of one track; the browser sends it when the listen ends):
//   { eid, trackId, ts (start), listenedMs, durationMs, type: play|skip|complete, src, offline }
// RULES (decided on the server, whatever the browser claims):
//   - under 3 s of real listening: discarded (accidental tap, tiny start). Never stored, never counted.
//   - a PLAY counts once listened time reaches 30 s, or half the track if it is shorter than a minute.
//   - below that threshold the listen is a SKIP only if the type says so or the track was left early; it adds listen time but no play.
//   - a COMPLETE is a play where the listener heard at least 80% of the track's length and the player reached its end.
//   - the same event id is never stored twice (retries and double sends are safe).
// WHERE IT LIVES: raw events are newline-delimited JSON, one file per month per user, in the MEDIA storage (analytics/YYYY-MM/<user>.jsonl),
// NOT in the Universe database, so the database file does not grow with every play. The database only keeps small running counters on
// each track (playCount, skipCount, listenMs, lastPlayedAt) and one tiny "tracking started" record.
import { createHash } from 'node:crypto';
import { HttpError, badRequest } from '../../../shared/errors.js';
import { v } from '../../../shared/validate.js';
import { eventIn } from './schema.js';

export const MIN_LISTEN_MS = 3000, COUNT_MS = 30_000, COMPLETE_RATIO = 0.8, MAX_BATCH = 100, MAX_RANGE_DAYS = 400;
const DAY = 86_400_000;
const ownerKey = (u) => createHash('sha1').update(u.id).digest('hex').slice(0, 12);
const monthOf = (iso) => iso.slice(0, 7);
const pathFor = (u, month) => `analytics/${month}/${ownerKey(u)}.jsonl`;

export function classify({ type, listenedMs, durationMs }) {
  if (listenedMs < MIN_LISTEN_MS) return null;
  const need = durationMs > 0 && durationMs < 60_000 ? durationMs * 0.5 : COUNT_MS;
  if (listenedMs < need) return 's';
  return type === 'complete' && durationMs > 0 && listenedMs >= durationMs * COMPLETE_RATIO ? 'c' : 'p';
}

export function makeAnalytics(s, media, lib) {
  const meta = s.storage.collection('jupiter_settings');
  const cache = new Map(); // path -> { at, rows }  (short-lived, per instance)
  const TTL = 60_000;

  async function readMonth(user, month) {
    const path = pathFor(user, month), hit = cache.get(path);
    if (hit && Date.now() - hit.at < TTL) return hit.rows;
    const buf = await media.readFile(path);
    const rows = [];
    if (buf) for (const line of buf.toString('utf8').split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* skip a damaged line */ } }
    cache.set(path, { at: Date.now(), rows });
    return rows;
  }

  async function ingest(user, rawEvents) {
    if (!Array.isArray(rawEvents) || !rawEvents.length) throw badRequest('events must be a non-empty list');
    if (rawEvents.length > MAX_BATCH) throw badRequest(`Send at most ${MAX_BATCH} events at a time`);
    const tracks = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
    const now = Date.now(), accepted = [], rejected = [];
    for (const raw of rawEvents) {
      let e; try { e = eventIn(raw); } catch (x) { rejected.push({ eid: raw?.eid, reason: x.message }); continue; }
      const t = tracks.get(e.trackId); const at = Date.parse(e.ts);
      if (!t) { rejected.push({ eid: e.eid, reason: 'unknown track' }); continue; }
      if (at > now + 5 * 60_000 || at < now - MAX_RANGE_DAYS * DAY) { rejected.push({ eid: e.eid, reason: 'time out of range' }); continue; }
      const dur = t.durationMs || e.durationMs;
      if (e.listenedMs > dur * 1.05 + 2000 && dur > 0) { rejected.push({ eid: e.eid, reason: 'listened longer than the track' }); continue; }
      const ty = classify({ type: e.type, listenedMs: e.listenedMs, durationMs: dur });
      if (!ty) { rejected.push({ eid: e.eid, reason: 'too short to count' }); continue; }
      accepted.push({ eid: e.eid, t: e.ts, id: e.trackId, ms: e.listenedMs, dur, ty, src: e.src, off: e.offline ? 1 : 0 });
    }
    if (!accepted.length) return { stored: 0, duplicates: 0, rejected };
    const byMonth = new Map();
    for (const a of accepted) { const m = monthOf(a.t); (byMonth.get(m) || byMonth.set(m, []).get(m)).push(a); }
    const adds = [], fresh = []; let duplicates = 0;
    for (const [month, list] of byMonth) {
      const path = pathFor(user, month); cache.delete(path);
      const old = await media.readFile(path); const text = old ? old.toString('utf8') : '';
      const have = new Set(); for (const line of text.split('\n')) { const m = /"eid":"([^"]+)"/.exec(line); if (m) have.add(m[1]); }
      const add = list.filter((e) => { if (have.has(e.eid)) { duplicates++; return false; } have.add(e.eid); return true; });
      if (!add.length) continue;
      const out = Buffer.from(text + (text && !text.endsWith('\n') ? '\n' : '') + add.map((e) => JSON.stringify(e)).join('\n') + '\n');
      adds.push({ path, ref: await media.putBlob(out) }); fresh.push(...add);
    }
    if (adds.length) {
      try { await media.commit({ add: adds, message: 'Jupiter: listening events' }); }
      catch (e) { s.log.error?.('Jupiter analytics commit failed:', e.message); throw new HttpError(503, 'Could not save listening history right now. It will be sent again later.', 'storage_failed'); }
      for (const a of adds) cache.delete(a.path);
    }
    // Running counters on the tracks (bounded: a few numbers per track).
    if (fresh.length) {
      await s.storage.transaction(async () => {
        const sums = new Map();
        for (const e of fresh) { const c = sums.get(e.id) || { plays: 0, skips: 0, ms: 0, last: null }; if (e.ty === 's') c.skips++; else { c.plays++; if (!c.last || e.t > c.last) c.last = e.t; } c.ms += e.ms; sums.set(e.id, c); }
        for (const [id, c] of sums) {
          const t = await lib.cols.tracks.get(id); if (!t) continue;
          await lib.cols.tracks.update(id, { playCount: (t.playCount || 0) + c.plays, skipCount: (t.skipCount || 0) + c.skips, listenMs: (t.listenMs || 0) + c.ms, lastPlayedAt: c.last && (!t.lastPlayedAt || c.last > t.lastPlayedAt) ? c.last : t.lastPlayedAt });
        }
        const m = await meta.get(`stats_${ownerKey(user)}`), first = fresh.map((e) => e.t).sort()[0];
        if (!m) await meta.insert({ id: `stats_${ownerKey(user)}`, ownerId: user.id, firstEventAt: first });
        else if (first < m.firstEventAt) await meta.update(m.id, { firstEventAt: first });
      });
    }
    return { stored: fresh.length, duplicates, rejected };
  }

  // ---- reading ----

  function rangeFor(kind, { from, to, now = new Date(), tz = 0 } = {}) {
    const local = (d) => new Date(d.getTime() + tz * 60_000);              // shift so UTC getters give the user's local calendar
    const unlocal = (d) => new Date(d.getTime() - tz * 60_000);
    const l = local(now), startOfDay = (x) => new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
    const today = startOfDay(l);
    let a, b = new Date(today.getTime() + DAY);
    if (kind === 'today') a = today;
    else if (kind === 'week') a = new Date(today.getTime() - 6 * DAY);
    else if (kind === 'month') a = new Date(today.getTime() - 29 * DAY);
    else if (kind === 'year') a = new Date(today.getTime() - 364 * DAY);
    else if (kind === 'all') a = new Date(today.getTime() - (MAX_RANGE_DAYS - 1) * DAY);
    else if (kind === 'custom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw badRequest('Custom ranges need from and to dates (YYYY-MM-DD)');
      a = new Date(`${from}T00:00:00Z`); b = new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) throw badRequest('The end date must be on or after the start date');
    } else throw badRequest('range must be today, week, month, year, all or custom');
    if ((b - a) / DAY > MAX_RANGE_DAYS + 1) throw badRequest(`Ranges can span at most ${MAX_RANGE_DAYS} days`);
    return { start: unlocal(a), end: unlocal(b), tz };
  }

  async function stats(user, { kind, from, to, tz = 0, limit = 10, now } = {}) {
    const r = rangeFor(kind, { from, to, tz, now });
    const months = []; for (let t = Date.UTC(r.start.getUTCFullYear(), r.start.getUTCMonth(), 1); t <= r.end.getTime(); ) { const d = new Date(t); months.push(d.toISOString().slice(0, 7)); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
    const all = [];
    for (let i = 0; i < months.length; i += 4) for (const rows of await Promise.all(months.slice(i, i + 4).map((m) => readMonth(user, m)))) all.push(...rows);
    const startIso = r.start.toISOString(), endIso = r.end.toISOString();
    const rows = all.filter((e) => e.t >= startIso && e.t < endIso);
    const tracks = new Map((await lib.allTracks(user)).map((t) => [t.id, t]));
    const tot = { plays: 0, completes: 0, skips: 0, listenMs: 0 }, byTrack = new Map(), byArtist = new Map(), byGenre = new Map(), byDay = new Map(), byHour = new Array(24).fill(0);
    for (const e of rows) {
      const t = tracks.get(e.id), isPlay = e.ty !== 's';
      tot.listenMs += e.ms; if (isPlay) tot.plays++; else tot.skips++; if (e.ty === 'c') tot.completes++;
      const day = new Date(Date.parse(e.t) + tz * 60_000), key = day.toISOString().slice(0, 10), d = byDay.get(key) || { date: key, plays: 0, listenMs: 0 };
      d.listenMs += e.ms; if (isPlay) d.plays++; byDay.set(key, d); byHour[day.getUTCHours()] += e.ms;
      const bt = byTrack.get(e.id) || { trackId: e.id, plays: 0, skips: 0, listenMs: 0 }; bt.listenMs += e.ms; if (isPlay) bt.plays++; else bt.skips++; byTrack.set(e.id, bt);
      if (t) {
        for (const a of t.artists) { const x = byArtist.get(a) || { name: a, plays: 0, listenMs: 0 }; x.listenMs += e.ms; if (isPlay) x.plays++; byArtist.set(a, x); }
        if (t.genre) { const x = byGenre.get(t.genre) || { name: t.genre, plays: 0, listenMs: 0 }; x.listenMs += e.ms; if (isPlay) x.plays++; byGenre.set(t.genre, x); }
      }
    }
    const top = (m, n) => [...m.values()].sort((a, b) => b.plays - a.plays || b.listenMs - a.listenMs).slice(0, n);
    const m = await meta.get(`stats_${ownerKey(user)}`), since = m?.firstEventAt || null;
    // Days before tracking began are "no data", NOT zero plays. Days after it with no events really are zero.
    const days = []; for (let t = r.start.getTime(); t < r.end.getTime(); t += DAY) { const k = new Date(t + tz * 60_000).toISOString().slice(0, 10), has = byDay.get(k);
      days.push(has ? has : { date: k, plays: 0, listenMs: 0, noData: !since || t + DAY <= Date.parse(since) }); }
    return { range: { kind, from: startIso, to: endIso, tz }, coverage: { trackingSince: since, hasAnyData: !!since, partial: !since || since > startIso },
      totals: { ...tot, uniqueTracks: byTrack.size }, topTracks: top(byTrack, limit).filter((x) => tracks.has(x.trackId)), topArtists: top(byArtist, limit), topGenres: top(byGenre, 8), byDay: days, byHour, events: rows.length };
  }
  return { ingest, stats, rangeFor, classify };
}
