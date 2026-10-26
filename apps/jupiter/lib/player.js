// The player: one <audio> element, a queue, shuffle/repeat, persistence, Media Session, and listening-event recording.
// Listening events follow the server's rules (see server/analytics.js): a "listen" is one stretch of one track; it is sent when it ends.
import { B, api } from '../services/api.js';
import * as offline from './offline.js';

const KEY = 'jupiter.player', EVKEY = 'jupiter.events', uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const audio = new Audio(); audio.preload = 'auto'; audio.crossOrigin = 'use-credentials';
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private mode */ } } };

export const P = { queue: [], index: -1, shuffle: false, repeat: 'off', volume: 1, src: 'library', tracks: new Map(), listeners: new Set(), offlineIds: new Set(), onError: () => {}, getArt: () => null };
const emit = () => { P.listeners.forEach((f) => f()); };
export const on = (f) => { P.listeners.add(f); return () => P.listeners.delete(f); };
export const current = () => P.tracks.get(P.queue[P.index]) || null;
export const state = () => ({ playing: !audio.paused && !audio.ended, pos: audio.currentTime || 0, dur: audio.duration || 0 });
let order = [], objectUrl = null, session = null, loadSeq = 0;

// ---- listening sessions ----
function openSession(t) { session = { eid: uid(), trackId: t.id, ts: new Date().toISOString(), ms: 0, last: null, dur: t.durationMs || 0, src: P.src, offline: P.offlineIds.has(t.id) && !navigator.onLine }; }
function tick() { if (!session || audio.paused) { if (session) session.last = null; return; } const now = performance.now(); if (session.last != null) { const d = now - session.last; if (d > 0 && d < 2500) session.ms += d; } session.last = now; }
function closeSession(type = 'play') {
  const s = session; session = null; if (!s) return; if (s.ms < 3000) return;
  const q = ls.get(EVKEY, []); q.push({ eid: s.eid, trackId: s.trackId, ts: s.ts, listenedMs: Math.round(s.ms), durationMs: s.dur, type, src: s.src, offline: s.offline }); ls.set(EVKEY, q.slice(-500)); flushEvents();
}
let flushing = false;
export async function flushEvents() {
  if (flushing || !navigator.onLine) return; const q = ls.get(EVKEY, []); if (!q.length) return; flushing = true;
  try { const batch = q.slice(0, 50); await api('POST', '/events', { events: batch }); const sent = new Set(batch.map((e) => e.eid)); ls.set(EVKEY, ls.get(EVKEY, []).filter((e) => !sent.has(e.eid))); }
  catch (e) { if (e.status === 400) ls.set(EVKEY, ls.get(EVKEY, []).slice(50)); /* bad events are dropped; network errors retry later */ }
  finally { flushing = false; }
}
addEventListener('online', flushEvents);
document.addEventListener('visibilitychange', () => { if (document.hidden) { tick(); persist(); } });
addEventListener('pagehide', () => { tick(); if (session && session.ms >= 3000) { const s = session; closeSession(audio.currentTime * 1000 >= (s.dur || 1) * 0.9 ? 'complete' : 'skip'); } persist(); });

// ---- loading and transport ----
async function load(t, startAt = 0, autoplay = true) {
  const seq = ++loadSeq; closeSession('skip'); if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  let src = null;
  if (P.offlineIds.has(t.id)) { try { src = await offline.blobUrl(t.id); } catch { src = null; } if (!src) { P.offlineIds.delete(t.id); } else objectUrl = src; }
  if (!src) { if (!navigator.onLine) { P.onError(`"${t.title}" is not downloaded and you are offline.`); return false; } src = `${B}/tracks/${t.id}/audio`; }
  if (seq !== loadSeq) return false;
  audio.src = src; audio.currentTime = 0; if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  openSession(t); emit(); updateMedia();
  if (autoplay) { try { await audio.play(); } catch (e) { if (e.name !== 'AbortError') P.onError(e.name === 'NotAllowedError' ? 'Tap play to start.' : `Could not play "${t.title}".`); } }
  return true;
}
function buildOrder(startId) { order = P.queue.map((_, i) => i); if (P.shuffle) { for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } const at = order.indexOf(P.index); if (at > 0) { [order[0], order[at]] = [order[at], order[0]]; } } }
const posInOrder = () => order.indexOf(P.index);
export function playList(tracks, startIndex = 0, { src = 'library', shuffle } = {}) {
  if (!tracks.length) return; for (const t of tracks) P.tracks.set(t.id, t);
  P.queue = tracks.map((t) => t.id); P.index = Math.max(0, Math.min(startIndex, tracks.length - 1)); P.src = src; if (shuffle != null) P.shuffle = shuffle; buildOrder(); persist(); return load(tracks[P.index]);
}
export function enqueue(tracks, where = 'append') { if (!tracks.length) return; for (const t of tracks) P.tracks.set(t.id, t);
  if (P.index < 0) return playList(tracks, 0, { src: 'queue' });
  const ids = tracks.map((t) => t.id); if (where === 'next') P.queue.splice(P.index + 1, 0, ...ids); else P.queue.push(...ids); buildOrder(); persist(); emit(); }
export function removeFromQueue(i) { if (i === P.index) return; P.queue.splice(i, 1); if (i < P.index) P.index--; buildOrder(); persist(); emit(); }
export function moveInQueue(i, dir) { const j = i + dir; if (j < 0 || j >= P.queue.length) return; [P.queue[i], P.queue[j]] = [P.queue[j], P.queue[i]]; if (P.index === i) P.index = j; else if (P.index === j) P.index = i; buildOrder(); persist(); emit(); }
export function jump(i) { if (i < 0 || i >= P.queue.length) return; P.index = i; buildOrder(); persist(); return load(current()); }
export function toggle() { if (P.index < 0) return; if (audio.paused) { if (!audio.src) load(current(), audio.currentTime); else audio.play().catch(() => {}); } else audio.pause(); }
export const pause = () => audio.pause(); export const resume = () => { if (audio.paused) toggle(); };
export function next(auto = false) {
  if (P.index < 0) return; const at = posInOrder();
  if (auto && P.repeat === 'one') { closeSession('complete'); return load(current()); }
  if (at < order.length - 1) { closeSession(auto ? 'complete' : 'skip'); P.index = order[at + 1]; persist(); return load(current()); }
  if (P.repeat === 'all') { closeSession(auto ? 'complete' : 'skip'); buildOrder(); P.index = order[0]; persist(); return load(current()); }
  if (auto) { closeSession('complete'); audio.pause(); audio.currentTime = 0; emit(); }
}
export function prev() { if (P.index < 0) return; if (audio.currentTime > 3) { audio.currentTime = 0; return; } const at = posInOrder(); if (at > 0) { closeSession('skip'); P.index = order[at - 1]; persist(); return load(current()); } audio.currentTime = 0; }
export const seek = (sec) => { if (Number.isFinite(sec)) { tick(); audio.currentTime = Math.max(0, Math.min(sec, audio.duration || sec)); if (session) session.last = null; } };
export const setVolume = (v) => { P.volume = Math.max(0, Math.min(1, v)); audio.volume = P.volume; persist(); emit(); };
export const setShuffle = (on) => { P.shuffle = on; buildOrder(); persist(); emit(); };
export const setRepeat = (r) => { P.repeat = r; persist(); emit(); };
export const cycleRepeat = () => setRepeat({ off: 'all', all: 'one', one: 'off' }[P.repeat]);

audio.addEventListener('timeupdate', () => { tick(); emit(); });
audio.addEventListener('play', () => { if (session) session.last = performance.now(); emit(); updateMedia(); }); audio.addEventListener('pause', () => { tick(); persist(); emit(); updateMedia(); });
audio.addEventListener('ended', () => next(true));
let retries = 0, retryFor = null;
audio.addEventListener('playing', () => { retries = 0; });
audio.addEventListener('error', () => {
  const t = current(); if (!t) return; const code = audio.error?.code, pos = audio.currentTime || 0;
  // A dropped or slow connection (code 2) is not a broken song: wait and resume the same track where it stopped. Never skip ahead because of the network.
  if (code === 2 || (code === 4 && !navigator.onLine)) {
    if (retryFor !== t.id) { retryFor = t.id; retries = 0; }
    if (retries < 6) { retries++; P.onError(navigator.onLine ? 'Weak connection. Retrying…' : 'You are offline. Will resume when you are back.'); const wait = navigator.onLine ? Math.min(8000, 800 * retries * retries) : 0;
      const go = () => { if (current()?.id === t.id) load(t, pos, true); }; if (navigator.onLine) setTimeout(go, wait); else addEventListener('online', go, { once: true }); return; }
    P.onError(`Connection too weak to keep playing "${t.title}". Tap play to try again.`); return;
  }
  closeSession('skip'); P.onError(code === 4 ? `"${t.title}" can't be played on this device (format or missing file).` : `Playback problem with "${t.title}".`);
  const at = posInOrder(); if (at < order.length - 1 && P.queue.length > 1) setTimeout(() => { P.index = order[at + 1]; load(current()); }, 600); });
audio.addEventListener('stalled', () => { if (!audio.paused && navigator.onLine) { const t = current(), pos = audio.currentTime; setTimeout(() => { if (current()?.id === t?.id && !audio.paused && audio.readyState < 3 && audio.currentTime === pos) { audio.load(); audio.currentTime = pos; audio.play().catch(() => {}); } }, 12000); } });
function persist() { ls.set(KEY, { queue: P.queue, index: P.index, pos: audio.currentTime || 0, shuffle: P.shuffle, repeat: P.repeat, volume: P.volume }); }
setInterval(() => { if (!audio.paused) persist(); }, 5000);
export function restore(tracksById) {
  const s = ls.get(KEY, null); if (!s) return; P.queue = (s.queue || []).filter((id) => tracksById.has(id)); P.shuffle = !!s.shuffle; P.repeat = s.repeat || 'off'; setVolumeQuiet(s.volume ?? 1);
  for (const id of P.queue) P.tracks.set(id, tracksById.get(id)); P.index = Math.min(P.queue.length - 1, s.index ?? -1); if (P.index >= 0 && P.queue[P.index] !== (s.queue || [])[s.index]) P.index = 0; buildOrder();
  const t = current(); if (t) { load(t, s.pos || 0, false); }
}
const setVolumeQuiet = (v) => { P.volume = v; audio.volume = v; };
function updateMedia() {
  if (!('mediaSession' in navigator)) return; const t = current(); if (!t) return;
  const art = P.getArt(t); navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artists.join(', '), album: t.album, artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}
if ('mediaSession' in navigator) for (const [a, f] of [['play', () => resume()], ['pause', pause], ['previoustrack', prev], ['nexttrack', () => next()], ['seekto', (d) => seek(d.seekTime)]]) { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* not supported */ } }
// Snapshot sent to Nebula so it can answer "what's playing?". Ids only; the server checks them against the real library.
export const snapshot = () => ({ jupiter: { trackId: current()?.id || null, playing: state().playing, positionSec: Math.round(audio.currentTime || 0), queueIds: P.queue.slice(P.index + 1, P.index + 31), shuffle: P.shuffle, repeat: P.repeat }, tzOffset: -new Date().getTimezoneOffset() });
