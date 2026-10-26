// Jupiter: your own music, in your own pocket. Installable app with its own sign-in, mini-player, Now Playing, offline downloads and Nebula.
import { api, h, toast, dialog, closer, B, sendBytes, fmtTime, fmtSize, setUnauthorizedHandler } from './services/api.js';
import { icon } from '/shared/icons.js';
import { api as rootApi } from '/shared/ui.js';
import { showAuth } from '/shared/auth.js';
import { registerServiceWorker, canPromptInstall, promptInstall, isStandalone } from '/shared/pwa.js';
import { renderMarkdown } from '/shared/markdown.js';
import * as pl from './lib/player.js';
import * as offline from './lib/offline.js';
import { readTags, guessFromName, audioDuration, shrinkImage } from './lib/tags.js';

const root = document.getElementById('app');
registerServiceWorker('/apps/jupiter/sw.js', '/apps/jupiter/');
const S = { me: null, meta: null, tracks: [], byId: new Map(), playlists: [], albums: [], artists: [], albumArt: new Map(), artistArt: new Map(), artistById: new Map(), offline: new Set(), dl: {}, offlineMode: false, q: '', tab: 'songs', tag: '', artistTab: 'popular', dlTab: 'downloaded', range: '30d', conv: null };
const brand = { name: 'Jupiter', blurb: 'Your own music, in your own pocket.', mark: () => h('img', { class: 'logo', src: '/apps/jupiter/icons/icon-192.png', alt: '' }) };
setUnauthorizedHandler(() => { if (S.me) { S.me = null; boot('Your session ended. Sign in again.'); } });
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const UNKNOWN = 'unknown';
const artKeyOf = (t) => t.artKey || S.albumArt.get(t.albumId) || (t.artistIds || []).map((i) => S.artistArt.get(i)).find(Boolean) || null;
const artUrl = (k) => (k ? `${B}/art/${k}` : null);
function artEl(key, { cls = '', ic = 'music', blue = false } = {}) { const a = h('div', { class: `art ${cls} ${blue ? 'blue' : ''}` }); if (key && !S.offlineMode) a.append(h('img', { src: artUrl(key), alt: '', loading: 'lazy', onerror: (e) => e.target.remove() })); else a.append(icon(ic)); return a; }
pl.P.getArt = (t) => (artKeyOf(t) ? new URL(artUrl(artKeyOf(t)), location.origin).href : null);
pl.P.onError = (m) => toast(m);
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function loadLibrary() {
  const lib = await api('GET', '/library');
  Object.assign(S, { tracks: lib.tracks, playlists: lib.playlists, albums: lib.albums, artists: lib.artists, used: lib.used });
  S.byId = new Map(S.tracks.map((t) => [t.id, t])); S.artistById = new Map(S.artists.map((a) => [a.id, a]));
  S.albumArt = new Map(S.albums.filter((a) => a.artKey).map((a) => [a.id, a.artKey])); S.artistArt = new Map(S.artists.filter((a) => a.artKey).map((a) => [a.id, a.artKey]));
  for (const t of S.tracks) pl.P.tracks.set(t.id, t);
}
async function refreshOffline() { S.offline = await offline.completeIds(); pl.P.offlineIds = S.offline; }
const songs = (ids) => ids.map((i) => S.byId.get(i)).filter(Boolean);
const by = (arr, f) => { const m = new Map(); for (const x of arr) for (const k of [].concat(f(x))) { if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const trackNo = (a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0) || a.title.localeCompare(b.title);
const albumsFrom = (tracks) => [...by(tracks, (t) => t.albumId)].map(([id, ts]) => ({ id, title: ts[0].album, artist: ts[0].albumArtist || ts[0].artists[0], tracks: ts.sort(trackNo), key: S.albumArt.get(id) || ts.find((t) => t.artKey)?.artKey })).sort((a, b) => a.title.localeCompare(b.title));
const unknownTracks = () => S.tracks.filter((t) => !t.artistIds.length);
const artistsList = () => { const l = S.artists.map((a) => ({ ...a, tracks: S.tracks.filter((t) => t.artistIds.includes(a.id)) })); const u = unknownTracks(); if (u.length) l.push({ id: UNKNOWN, name: 'Unknown artist', tracks: u, virtual: true }); return l; };

// ---------------- shell ----------------
const NAV = [['#/', 'Home', 'home', 'home'], ['#/library', 'Library', 'library', 'music'], ['#/artists', 'Artists', 'artists', 'user'], ['#/stats', 'Analytics', 'stats', 'chart'], ['#/more', 'More', 'more', 'more']];
function frame(page, ...content) {
  const link = ([href, text, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, text));
  const nav = S.offlineMode ? [['#/downloads', 'Offline', 'downloads', 'download']] : NAV;
  root.className = pl.current() ? '' : 'has-no-mini';
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('a', { class: 'brand', href: '#/' }, h('img', { src: '/apps/jupiter/icons/icon-192.png', alt: '' }), 'Jupiter'), nav.map(link), S.offlineMode ? null : link(['#/downloads', 'Offline', 'downloads', 'download'])),
    h('main', { class: 'main' }, S.offlineMode ? h('div', { class: 'offline-banner' }, 'Offline mode: only tracks you downloaded can play.') : null, ...content),
    h('nav', { class: 'bottom', 'aria-label': 'Main' }, nav.map(link))));
  window.scrollTo(0, 0); drawMini();
}
const initial = () => (S.me?.user?.displayName || '?').trim()[0]?.toUpperCase() || '?';
const topbar = (title, ...extra) => h('div', { class: 'top' }, h('img', { class: 'logo', src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('h1', {}, title), ...extra,
  S.meta?.can?.ai && !S.offlineMode ? h('button', { class: 'iconbtn', title: 'Ask Nebula', 'aria-label': 'Ask Nebula', onclick: openNebula }, icon('sparkle')) : null,
  h('a', { class: 'avatar', href: '#/more', 'aria-label': 'More' }, initial()));
const backbar = (...extra) => h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => (history.length > 1 ? history.back() : (location.hash = '#/')) }, icon('back')), h('div', { style: 'flex:1' }), ...extra);
const emptyState = (text, btn) => h('div', { class: 'empty' }, h('img', { class: 'empty-logo', src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('p', {}, text), btn || null);

// ---------------- rows and menus ----------------
function trackRow(t, list, i, { src = 'library', extra, numbered } = {}) {
  const now = pl.current()?.id === t.id;
  return h('div', { class: `row-t ${now ? 'now' : ''}`, onclick: () => pl.playList(list, i, { src }) },
    numbered ? h('span', { class: 'num' }, i + 1) : null, artEl(artKeyOf(t)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, t.title, S.offline.has(t.id) ? h('span', { class: 'tag' }, 'offline') : null), h('div', { class: 'sub2' }, `${t.artists.join(', ')} · ${t.durationMs ? fmtTime(t.durationMs) : t.album}`)),
    extra || null, h('button', { class: `iconbtn ${t.liked ? 'on' : ''}`, 'aria-label': t.liked ? 'Unlike' : 'Like', onclick: (e) => { e.stopPropagation(); toggleLike(t); } }, icon('heart')),
    h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: (e) => { e.stopPropagation(); trackMenu(t); } }, icon('more')));
}
async function toggleLike(t) { try { const r = await api('PATCH', `/tracks/${t.id}`, { liked: !t.liked }); Object.assign(t, { liked: r.track.liked }); route(); drawNow(); } catch (x) { toast(x.message); } }
function menu(title, sub, items) {
  const d = dialog(title, sub ? h('p', { class: 'sub' }, sub) : null, h('div', { class: 'menu' }, items.filter(Boolean).map(([ic, text, fn, cls]) => h('button', { class: cls || '', onclick: () => { d.close(); fn(); } }, icon(ic), text))), closer());
  return d;
}
function trackMenu(t) {
  const W = S.meta.can.write;
  menu(t.title, t.artists.join(', '), [['play', 'Play next', () => { pl.enqueue([t], 'next'); toast('Playing next'); }], ['queue', 'Add to queue', () => { pl.enqueue([t]); toast('Added to queue'); }], W && ['plus', 'Add to playlist', () => addToPlaylist([t.id])],
    S.offline.has(t.id) ? ['trash', 'Remove download', async () => { await offline.remove(t.id); await refreshOffline(); route(); toast('Download removed'); }] : (S.dl[t.id] != null ? null : ['download', 'Download for offline', () => startDownload(t)]),
    W && ['pencil', 'Edit details, artist and artwork', () => editTrack(t)], ['disc', 'Go to album', () => { location.hash = `#/album/${t.albumId}`; }], ['user', 'Go to artist', () => { location.hash = `#/artist/${t.artistIds[0] || UNKNOWN}`; }],
    S.meta.can.delete && ['trash', 'Delete this song…', () => confirmDeleteTrack(t), 'danger']]);
}
function confirmDeleteTrack(t) {
  const d = dialog('Delete this song?', h('p', {}, `"${t.title}" will be deleted from your storage permanently. Playlists lose it too. This cannot be undone.`), h('div', { class: 'actions' },
    h('button', { class: 'btn danger', onclick: async () => { try { await api('DELETE', `/tracks/${t.id}?confirm=true`); if (S.offline.has(t.id)) await offline.remove(t.id); d.close(); await loadLibrary(); await refreshOffline(); toast('Song deleted'); route(); } catch (x) { toast(x.message); } } }, 'Delete forever'), closer('Keep it')));
}
function addToPlaylist(ids) {
  menu('Add to playlist', null, [...S.playlists.map((p) => ['queue', p.name, async () => { try { await api('POST', `/playlists/${p.id}/tracks`, { trackIds: ids }); await loadLibrary(); toast(`Added to ${p.name}`); route(); } catch (x) { toast(x.message); } }]), ['plus', 'New playlist…', () => newPlaylist(ids)]]);
}
function newPlaylist(ids = []) {
  const name = h('input', { placeholder: 'Playlist name', maxlength: 100, 'aria-label': 'Playlist name' });
  const d = dialog('New playlist', name, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/playlists', { name: name.value || 'New playlist', trackIds: ids }); d.close(); await loadLibrary(); location.hash = `#/playlist/${r.playlist.id}`; } catch (x) { toast(x.message); } } }, 'Create'), closer()));
  name.focus();
}
// Artists are created here, on purpose. Resolves with the new artist (or null if cancelled).
function newArtist(prefill = '') {
  return new Promise((resolve) => {
    const name = h('input', { placeholder: 'Artist name', maxlength: 200, value: prefill, 'aria-label': 'Artist name' }), err = h('p', { class: 'err', role: 'alert' }); let made = null;
    const d = dialog('New artist', name, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { made = (await api('POST', '/artists', { name: name.value })).artist; d.close(); await loadLibrary(); toast(`${made.name} created`); } catch (x) { err.textContent = x.message; } } }, 'Create artist'), closer()));
    d.addEventListener('close', () => resolve(made)); name.focus();
  });
}
// Choose which of YOUR artists a song belongs to. Nothing is created unless you tap "New artist".
function artistPicker(selected = []) {
  const sel = new Set(selected), box = h('div', { class: 'chips wrap' });
  const draw = () => box.replaceChildren(S.artists.map((a) => h('button', { type: 'button', class: 'chip', 'aria-pressed': sel.has(a.id) ? 'true' : 'false', onclick: () => { sel.has(a.id) ? sel.delete(a.id) : sel.add(a.id); draw(); } }, a.name)),
    h('button', { type: 'button', class: 'chip add', onclick: async () => { const a = await newArtist(); if (a) { sel.add(a.id); draw(); } } }, '+ New artist'), !S.artists.length ? h('span', { class: 'fine muted' }, 'No artists yet. Leave empty to file this under Unknown artist.') : null);
  draw(); return { el: box, get: () => [...sel], add: (id) => { sel.add(id); draw(); }, redraw: draw };
}

// ---------------- downloads ----------------
async function startDownload(t) {
  if (S.dl[t.id] != null) return; S.dl[t.id] = 0; toast('Downloading…');
  try { await offline.download(t, { base: B, partSize: S.meta.partSize, artUrl: artKeyOf(t) ? artUrl(artKeyOf(t)) : null, onProgress: (p) => { S.dl[t.id] = p; drawDlProgress(); } }); toast(`"${t.title}" is available offline`); }
  catch (e) { toast(e.missing ? 'That file is missing from storage.' : e.quota ? e.message : `Download failed: ${e.message}`); }
  delete S.dl[t.id]; await refreshOffline(); route();
}
const drawDlProgress = () => { for (const [id, p] of Object.entries(S.dl)) { const el = document.querySelector(`[data-dl="${id}"] i`); if (el) el.style.width = `${Math.round(p * 100)}%`; const pc = document.querySelector(`[data-dl="${id}"] .pc`); if (pc) pc.textContent = `${Math.round(p * 100)}%`; } };
async function downloadsView() {
  const metas = await offline.list(), done = metas.filter((m) => m.done), u = await offline.usage(), items = done.map((m) => ({ ...(S.byId.get(m.id) || m.track), artistIds: (S.byId.get(m.id) || m.track).artistIds || [], artists: (S.byId.get(m.id) || m.track).artists || ['Unknown artist'] }));
  const active = Object.keys(S.dl).map((id) => S.byId.get(id)).filter(Boolean), pct = u.quota ? Math.min(100, (u.bytes / u.quota) * 100) : 0;
  const tabs = [['downloaded', 'Downloaded'], ['downloading', `Downloading${active.length ? ` (${active.length})` : ''}`], ['storage', 'Storage']];
  let body;
  if (S.dlTab === 'downloaded') body = items.length ? h('div', { class: 'rows' }, items.map((t, i) => trackRow(t, items, i, { src: 'downloads', extra: h('span', { class: 'okdot', title: 'Available offline' }, icon('check')) }))) : emptyState('Nothing downloaded yet. Open a song\'s ⋯ menu and choose "Download for offline". Only songs you choose are saved.');
  else if (S.dlTab === 'downloading') body = active.length ? h('div', { class: 'rows' }, active.map((t) => h('div', { class: 'row-t', 'data-dl': t.id }, artEl(artKeyOf(t)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, t.title), h('div', { class: 'prog' }, h('i', { style: `width:${Math.round((S.dl[t.id] || 0) * 100)}%` }))), h('span', { class: 'dur pc' }, `${Math.round((S.dl[t.id] || 0) * 100)}%`)))) : emptyState('No downloads in progress.');
  else body = h('div', { class: 'card' }, h('div', { class: 'between' }, h('b', {}, 'Storage used on this device'), h('span', {}, fmtSize(u.bytes))), h('div', { class: 'prog big' }, h('i', { style: `width:${pct}%` })), h('p', { class: 'fine muted' }, `${plural(done.length, 'song')} saved.${u.quota ? ` The browser allows about ${fmtSize(u.quota)} for this site.` : ''} ${u.persisted ? 'Storage is marked persistent.' : 'The browser may clear it if the device runs low.'}`),
    done.length ? h('button', { class: 'btn ghost danger', onclick: async () => { if (confirm('Remove all downloads from this device? Your library is not affected.')) { await offline.removeAll(); await refreshOffline(); route(); } } }, 'Remove all downloads') : null,
    h('p', { class: 'fine muted' }, 'Downloads live in this browser\'s own storage, not the page cache. Browsers can clear it under pressure, and iOS may clear it for sites not added to the Home Screen. This is not a backup.'));
  frame('downloads', S.offlineMode ? topbar('Offline Music') : backbar(h('h1', { style: 'margin:0' }, 'Offline Music'), h('div', { style: 'flex:1' })), h('div', { class: 'chips' }, tabs.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': S.dlTab === k ? 'true' : 'false', onclick: () => { S.dlTab = k; route(); } }, l))), body);
}

// ---------------- Home ----------------
function homeView() {
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const played = [...S.tracks].filter((t) => t.lastPlayedAt).sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt)), last = pl.current() || played[0];
  const added = [...S.tracks].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 12), liked = S.tracks.filter((t) => t.liked);
  const quick = [['heart', 'Liked Songs', plural(liked.length, 'song'), 'blue', () => { S.tab = 'songs'; S.likedOnly = true; location.hash = '#/library'; }], ['play', 'Recently Played', plural(Math.min(50, played.length), 'song'), 'orange', () => { if (played.length) pl.playList(played.slice(0, 50), 0, { src: 'library' }); }],
    ['user', 'Your Artists', plural(artistsList().length, 'artist'), 'violet', () => { location.hash = '#/artists'; }], ['disc', 'Your Albums', plural(albumsFrom(S.tracks).length, 'album'), 'indigo', () => { S.tab = 'albums'; location.hash = '#/library'; }]];
  const search = h('input', { type: 'search', placeholder: 'Search songs, artists, albums, tags…', 'aria-label': 'Search', onkeydown: (e) => { if (e.key === 'Enter') { S.q = e.target.value; S.tab = 'songs'; location.hash = '#/library'; } } });
  frame('home', topbar('Jupiter'), h('div', { class: 'searchfield' }, icon('search'), search),
    h('h2', { class: 'greet' }, `${greet}, ${S.me.user.displayName.split(' ')[0]} `, h('span', {}, '👋')), h('p', { class: 'muted', style: 'margin:.1rem 0 1rem' }, 'Let\'s make today amazing.'),
    last ? h('div', { class: 'lastcard', onclick: () => pl.playList([last, ...played.filter((t) => t.id !== last.id)].slice(0, 50), 0, { src: 'library' }) }, artEl(artKeyOf(last)), h('div', { class: 'meta' }, h('small', {}, pl.current() ? 'Now playing' : 'Last played'), h('div', { class: 'ttl' }, last.title), h('div', { class: 'sub2' }, last.artists.join(', '))), h('span', { class: 'bigplay' }, icon('play'))) : null,
    !S.tracks.length ? emptyState('Your library is empty. Add the music you own to start.', h('a', { class: 'btn', href: '#/upload' }, icon('upload'), 'Add music')) : null,
    S.tracks.length ? h('div', {}, h('h2', { class: 'sec' }, 'Quick Access'), h('div', { class: 'quick' }, quick.map(([ic, t, s, c, fn]) => h('button', { class: 'qtile', onclick: fn }, h('span', { class: `qic ${c}` }, icon(ic)), h('span', { class: 'meta' }, h('b', {}, t), h('small', {}, s)))))) : null,
    S.tracks.length ? h('div', {}, h('h2', { class: 'sec' }, 'Recently Added', h('a', { href: '#/library', onclick: () => { S.tab = 'songs'; }, class: 'seeall' }, 'See all')), h('div', { class: 'scroller' }, added.map((t, i) => h('div', { class: 'tile', onclick: () => pl.playList(added, i, { src: 'library' }) }, artEl(artKeyOf(t), { cls: 'big' }), h('div', { class: 'ttl' }, t.title), h('div', { class: 'sub2' }, t.artists.join(', ')))))) : null,
    S.playlists.length ? h('div', {}, h('h2', { class: 'sec' }, 'Playlists'), h('div', { class: 'scroller' }, S.playlists.map((p) => h('div', { class: 'tile', onclick: () => { location.hash = `#/playlist/${p.id}`; } }, artEl(artKeyOf(songs(p.trackIds)[0] || {}), { cls: 'big', ic: 'queue', blue: true }), h('div', { class: 'ttl' }, p.name), h('div', { class: 'sub2' }, plural(p.trackIds.length, 'song')))))) : null);
}

// ---------------- Library ----------------
function libraryView() {
  const q = norm(S.q).split(/\s+/).filter(Boolean);
  let rows = S.tracks.filter((t) => { const hay = norm([t.title, t.artists.join(' '), t.album, t.genre, t.tags.join(' ')].join(' ')); return q.every((x) => hay.includes(x)) && (!S.likedOnly || t.liked) && (!S.tag || t.tags.includes(S.tag)); }).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const search = h('input', { type: 'search', placeholder: 'Search your library…', value: S.q, 'aria-label': 'Search your library', oninput: (e) => { S.q = e.target.value; clearTimeout(search._t); search._t = setTimeout(() => { libraryView(); const i = document.querySelector('.searchfield input'); i?.focus(); i?.setSelectionRange(S.q.length, S.q.length); }, 200); } });
  const tabs = ['songs', 'albums', 'artists', 'playlists', 'tags']; let body;
  if (S.tab === 'songs') body = rows.length ? h('div', { class: 'rows' }, rows.map((t, i) => trackRow(t, rows, i, { src: S.q ? 'search' : 'library' }))) : emptyState(S.tracks.length ? 'No songs match.' : 'No music yet.', S.tracks.length ? null : h('a', { class: 'btn', href: '#/upload' }, 'Add music'));
  else if (S.tab === 'albums') { const al = albumsFrom(S.tracks).filter((a) => !q.length || q.every((x) => norm(a.title + a.artist).includes(x))); body = al.length ? h('div', { class: 'grid' }, al.map((a) => h('div', { class: 'tile', onclick: () => { location.hash = `#/album/${a.id}`; } }, artEl(a.key, { cls: 'big', ic: 'disc' }), h('div', { class: 'ttl' }, a.title), h('div', { class: 'sub2' }, a.artist)))) : emptyState('No albums yet.'); }
  else if (S.tab === 'artists') body = artistRows(q);
  else if (S.tab === 'playlists') body = h('div', { class: 'rows' }, S.meta.can.write ? h('div', { class: 'row-t', onclick: () => newPlaylist() }, h('div', { class: 'art blue' }, icon('plus')), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, 'New playlist'))) : null,
    S.playlists.map((p) => h('div', { class: 'row-t', onclick: () => { location.hash = `#/playlist/${p.id}`; } }, artEl(artKeyOf(songs(p.trackIds)[0] || {}), { ic: 'queue', blue: true }), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, p.name), h('div', { class: 'sub2' }, plural(p.trackIds.length, 'song'))),
      S.meta.can.write ? h('button', { class: 'iconbtn', 'aria-label': 'Playlist options', onclick: (e) => { e.stopPropagation(); playlistMenu(p); } }, icon('more')) : null)));
  else { const tags = [...by(S.tracks, (t) => t.tags)].sort((a, b) => b[1].length - a[1].length); body = tags.length ? h('div', { class: 'chips wrap' }, tags.map(([tag, ts]) => h('button', { class: 'chip', 'aria-pressed': S.tag === tag ? 'true' : 'false', onclick: () => { S.tag = S.tag === tag ? '' : tag; S.tab = 'songs'; libraryView(); } }, `${tag} · ${ts.length}`))) : emptyState('No tags yet. Add custom tags when you upload or edit a song.'); }
  frame('library', h('div', { class: 'top' }, h('h1', {}, 'Your Library'), S.meta.can.write ? h('a', { class: 'iconbtn', href: '#/upload', 'aria-label': 'Add music', title: 'Add music' }, icon('plus')) : null, S.meta?.can?.ai ? h('button', { class: 'iconbtn', 'aria-label': 'Ask Nebula', onclick: openNebula }, icon('sparkle')) : null),
    h('div', { class: 'chips' }, tabs.map((t) => h('button', { class: 'chip', 'aria-pressed': S.tab === t ? 'true' : 'false', onclick: () => { S.tab = t; libraryView(); } }, t[0].toUpperCase() + t.slice(1))), h('button', { class: 'chip', 'aria-pressed': S.likedOnly ? 'true' : 'false', onclick: () => { S.likedOnly = !S.likedOnly; S.tab = 'songs'; libraryView(); } }, '♥ Liked')),
    h('div', { class: 'searchfield' }, icon('search'), search), S.tag ? h('p', { class: 'fine' }, `Tag: ${S.tag} `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.tag = ''; libraryView(); } }, 'clear')) : null, body);
}
function artistRows(q = []) {
  const list = artistsList().filter((a) => !q.length || q.every((x) => norm(a.name).includes(x)));
  return h('div', { class: 'rows' }, S.meta.can.write ? h('div', { class: 'row-t', onclick: async () => { const a = await newArtist(); if (a) { location.hash = `#/artist/${a.id}`; } } }, h('div', { class: 'art blue round' }, icon('plus')), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, 'New artist'), h('div', { class: 'sub2' }, 'Artists are only created by you'))) : null,
    list.map((a) => h('div', { class: 'row-t', onclick: () => { location.hash = `#/artist/${a.id}`; } }, artEl(S.artistArt.get(a.id) || (a.tracks[0] && artKeyOf(a.tracks[0])), { cls: 'round', ic: 'user' }), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, a.name), h('div', { class: 'sub2' }, plural(a.tracks.length, 'song'))),
      !a.virtual && S.meta.can.write ? h('button', { class: 'iconbtn', 'aria-label': 'Artist options', onclick: (e) => { e.stopPropagation(); artistMenu(a); } }, icon('more')) : null)));
}
function artistsView() { frame('artists', h('div', { class: 'top' }, h('h1', {}, 'Artists')), artistRows()); }
function playlistMenu(p) { menu(p.name, plural(p.trackIds.length, 'song'), [['pencil', 'Rename', () => renamePlaylist(p)], p.trackIds.length && ['x', 'Clear all songs from playlist…', () => confirmPlaylist(p, 'clear'), 'danger'], ['trash', 'Delete playlist…', () => confirmPlaylist(p, 'delete'), 'danger']]); }
function artistMenu(a) { menu(a.name, plural(a.tracks.length, 'song'), [['pencil', 'Edit artist', () => editArtist(a)], ['trash', 'Delete artist…', () => confirmDeleteArtist(a), 'danger']]); }

// ---------------- Artist, album, playlist pages ----------------
function heroBanner(key, title, sub, round) {
  const b = h('div', { class: 'banner' }); if (key && !S.offlineMode) b.style.backgroundImage = `url(${artUrl(key)})`; else b.append(h('div', { class: 'ph' }, icon(round ? 'user' : 'disc')));
  b.append(h('div', { class: 'shade' }), h('div', { class: 'cap' }, h('h1', {}, title), h('div', { class: 'muted' }, sub))); return b;
}
function playRow(tracks, src, extra) { return h('div', { class: 'actions two' }, h('button', { class: 'btn', onclick: () => pl.playList(tracks, 0, { src }) }, icon('play'), 'Play'), h('button', { class: 'btn ghost', onclick: () => pl.playList(tracks, 0, { src, shuffle: true }) }, icon('shuffle'), 'Shuffle'), ...(extra || [])); }
function artistView(id) {
  const a = artistsList().find((x) => x.id === id); if (!a) return frame('artists', backbar(), emptyState('Artist not found.'));
  const prof = S.artistById.get(id), albums = albumsFrom(a.tracks), singles = a.tracks.filter((t) => t.album === 'Unknown album' || albums.find((al) => al.id === t.albumId)?.tracks.length === 1), popular = [...a.tracks].sort((x, y) => y.playCount - x.playCount || x.title.localeCompare(y.title));
  const tabs = [['popular', 'Popular'], ['albums', 'Albums'], ['singles', 'Singles'], ['about', 'About']]; let body;
  if (S.artistTab === 'popular') body = h('div', { class: 'rows' }, popular.map((t, i) => trackRow(t, popular, i, { src: 'artist', numbered: true })));
  else if (S.artistTab === 'albums') body = albums.length ? h('div', { class: 'grid' }, albums.map((al) => h('div', { class: 'tile', onclick: () => { location.hash = `#/album/${al.id}`; } }, artEl(al.key, { cls: 'big', ic: 'disc' }), h('div', { class: 'ttl' }, al.title), h('div', { class: 'sub2' }, plural(al.tracks.length, 'song'))))) : emptyState('No albums.');
  else if (S.artistTab === 'singles') body = singles.length ? h('div', { class: 'rows' }, singles.map((t, i) => trackRow(t, singles, i, { src: 'artist' }))) : emptyState('No singles.');
  else body = h('div', { class: 'card' }, h('p', {}, prof?.description || (a.virtual ? 'Songs without an artist are filed here. Open a song\'s ⋯ menu → Edit to give it an artist.' : 'No description yet.')), !a.virtual && S.meta.can.write ? h('button', { class: 'btn ghost', onclick: () => editArtist({ ...a, ...prof }) }, 'Edit about') : null);
  frame('artists', backbar(!a.virtual && S.meta.can.write ? h('button', { class: 'iconbtn', 'aria-label': 'Artist options', onclick: () => artistMenu(a) }, icon('more')) : null), heroBanner(S.artistArt.get(id) || (a.tracks[0] && artKeyOf(a.tracks[0])), a.name, `${plural(a.tracks.length, 'song')} · ${plural(albums.length, 'album')}`, true), playRow(a.tracks, 'artist'),
    h('div', { class: 'chips tabs' }, tabs.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': S.artistTab === k ? 'true' : 'false', onclick: () => { S.artistTab = k; artistView(id); } }, l))), body);
}
function albumView(id) {
  const a = albumsFrom(S.tracks).find((x) => x.id === id); if (!a) return frame('library', backbar(), emptyState('Album not found.')); const prof = S.albums.find((x) => x.id === id);
  frame('library', backbar(S.meta.can.write ? h('button', { class: 'iconbtn', 'aria-label': 'Album options', onclick: () => menu(a.title, a.artist, [['pencil', 'Edit album', () => editAlbum(a, prof)], ['trash', 'Delete album…', () => confirmDeleteAlbum(a), 'danger']]) }, icon('more')) : null),
    heroBanner(a.key, a.title, `${a.artist} · ${plural(a.tracks.length, 'song')}`, false), prof?.description ? h('p', { class: 'muted' }, prof.description) : null, playRow(a.tracks, 'album'), h('div', { class: 'rows' }, a.tracks.map((t, i) => trackRow(t, a.tracks, i, { src: 'album', numbered: true }))));
}
function playlistView(id) {
  const p = S.playlists.find((x) => x.id === id); if (!p) return frame('library', backbar(), emptyState('Playlist not found.'));
  const list = songs(p.trackIds), save = async (ids) => { try { await api('PUT', `/playlists/${p.id}/tracks`, { trackIds: ids }); await loadLibrary(); route(); } catch (x) { toast(x.message); } };
  const move = (i, d) => { const ids = [...p.trackIds], j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; save(ids); };
  frame('library', backbar(S.meta.can.write ? h('button', { class: 'iconbtn', 'aria-label': 'Playlist options', onclick: () => playlistMenu(p) }, icon('more')) : null), heroBanner(artKeyOf(list[0] || {}), p.name, plural(list.length, 'song'), false), p.description ? h('p', { class: 'muted' }, p.description) : null, list.length ? playRow(list, 'playlist') : null,
    list.length ? h('div', { class: 'rows' }, list.map((t, i) => trackRow(t, list, i, { src: 'playlist', extra: S.meta.can.write ? h('span', { style: 'display:flex' }, h('button', { class: 'iconbtn', 'aria-label': 'Move up', onclick: (e) => { e.stopPropagation(); move(i, -1); } }, icon('up')), h('button', { class: 'iconbtn', 'aria-label': 'Move down', onclick: (e) => { e.stopPropagation(); move(i, 1); } }, icon('down')),
      h('button', { class: 'iconbtn', 'aria-label': 'Remove from playlist', title: 'Remove from playlist (keeps the song)', onclick: (e) => { e.stopPropagation(); save(p.trackIds.filter((_, k) => k !== i)); } }, icon('x'))) : null }))) : emptyState('This playlist is empty. Add songs from any song\'s ⋯ menu.'));
}
function renamePlaylist(p) { const name = h('input', { value: p.name, maxlength: 100 }); const d = dialog('Rename playlist', name, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', `/playlists/${p.id}`, { name: name.value }); d.close(); await loadLibrary(); route(); } catch (x) { toast(x.message); } } }, 'Save'), closer())); }
function confirmPlaylist(p, what) {
  const del = what === 'delete'; const d = dialog(del ? 'Delete this playlist?' : 'Clear this playlist?', h('p', {}, del ? `"${p.name}" will be deleted. Its ${plural(p.trackIds.length, 'song')} stay in your library.` : `All ${plural(p.trackIds.length, 'song')} will be removed from "${p.name}". The songs stay in your library.`),
    h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => { try { if (del) { await api('DELETE', `/playlists/${p.id}?confirm=true`); if (location.hash.includes(p.id)) location.hash = '#/library'; } else await api('PUT', `/playlists/${p.id}/tracks`, { trackIds: [] }); d.close(); await loadLibrary(); toast(del ? 'Playlist deleted' : 'Playlist cleared'); route(); } catch (x) { toast(x.message); } } }, del ? 'Delete playlist' : 'Clear playlist'), closer('Cancel')));
}
// Deleting an artist/album never deletes songs unless you pick that option.
function confirmDeleteArtist(a) {
  const solo = a.tracks.filter((t) => t.artistIds.length === 1).length, d = dialog(`Delete ${a.name}?`, h('p', {}, `${a.name} has ${plural(a.tracks.length, 'song')}.`), h('div', { class: 'actions col' },
    h('button', { class: 'btn', onclick: () => go(false) }, 'Delete artist, keep songs'), h('p', { class: 'fine muted' }, 'Songs stay in your library and move to Unknown artist.'),
    S.meta.can.delete ? [h('button', { class: 'btn danger', onclick: () => go(true) }, `Delete artist and ${plural(solo, 'song')}`), h('p', { class: 'fine muted' }, 'Deletes the audio files for songs where this is the only artist. Songs shared with other artists are kept. Cannot be undone.')] : null, closer('Cancel')));
  async function go(songsToo) { try { const r = await api('DELETE', `/artists/${a.id}?confirm=true&songs=${songsToo ? 'delete' : 'keep'}`); d.close(); await loadLibrary(); await refreshOffline(); toast(r.deletedSongs ? `Artist and ${plural(r.deletedSongs, 'song')} deleted` : 'Artist deleted'); location.hash = '#/artists'; route(); } catch (x) { toast(x.message); } }
}
function confirmDeleteAlbum(a) {
  const d = dialog(`Delete "${a.title}"?`, h('p', {}, `This album has ${plural(a.tracks.length, 'song')}.`), h('div', { class: 'actions col' },
    h('button', { class: 'btn', onclick: () => go(false) }, 'Remove album, keep songs'), h('p', { class: 'fine muted' }, 'Songs stay in your library under "Unknown album".'),
    S.meta.can.delete ? [h('button', { class: 'btn danger', onclick: () => go(true) }, `Delete album and ${plural(a.tracks.length, 'song')}`), h('p', { class: 'fine muted' }, 'Deletes the audio files permanently.')] : null, closer('Cancel')));
  async function go(songsToo) { try { await api('DELETE', `/albums/${a.id}?confirm=true&songs=${songsToo ? 'delete' : 'keep'}`); d.close(); await loadLibrary(); await refreshOffline(); toast('Album removed'); location.hash = '#/library'; route(); } catch (x) { toast(x.message); } }
}

// ---------------- editing ----------------
const artPicker = () => h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
async function putArt(kind, id, file) { const small = (await shrinkImage(file)) || file; if (small.size > 2 * 1024 * 1024) throw new Error('That image is too large (2 MB max).'); return sendBytes(`/${kind}s/${id}/artwork`, small); }
function editTrack(t) {
  const f = (k, label, props = {}) => [h('label', {}, label), h('input', { value: t[k] ?? '', ...props })];
  const title = f('title', 'Title', { maxlength: 200 }), album = f('album', 'Album'), aa = f('albumArtist', 'Album artist (optional)'), genre = f('genre', 'Genre'), tn = f('trackNo', 'Track no.', { type: 'number', min: 1 }), dn = f('discNo', 'Disc no.', { type: 'number', min: 1 }), yr = f('year', 'Year', { type: 'number' }), rd = f('releaseDate', 'Release date', { placeholder: '2024-05-31' });
  const tags = [h('label', {}, 'Custom tags (comma separated)'), h('input', { value: t.tags.join(', ') })], desc = [h('label', {}, 'Description'), h('textarea', { rows: 3, maxlength: 2000 }, t.description || '')], art = artPicker(), err = h('p', { class: 'err', role: 'alert' }), pick = artistPicker(t.artistIds);
  const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean), n = (el) => (el.value === '' ? null : Number(el.value));
  const d = dialog('Edit song', ...title, h('label', {}, 'Artists'), pick.el, h('div', { class: 'field-row' }, h('div', {}, ...album), h('div', {}, ...aa)), h('div', { class: 'field-row' }, h('div', {}, ...genre), h('div', {}, ...yr)), h('div', { class: 'field-row' }, h('div', {}, ...tn), h('div', {}, ...dn)), ...rd, ...tags, ...desc,
    h('label', {}, 'Replace cover art'), art, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try {
      await api('PATCH', `/tracks/${t.id}`, { title: title[1].value, artistIds: pick.get(), album: album[1].value, albumArtist: aa[1].value, genre: genre[1].value, trackNo: n(tn[1]), discNo: n(dn[1]), year: n(yr[1]), releaseDate: rd[1].value || null, tags: csv(tags[1].value), description: desc[1].value });
      if (art.files[0]) await putArt('track', t.id, art.files[0]); d.close(); await loadLibrary(); toast('Saved'); route(); } catch (x) { err.textContent = x.message; e.currentTarget.disabled = false; } } }, 'Save'),
      t.artKey ? h('button', { class: 'btn ghost', onclick: async () => { try { await api('PATCH', `/tracks/${t.id}`, { removeArt: true }); d.close(); await loadLibrary(); route(); } catch (x) { err.textContent = x.message; } } }, 'Remove art') : null, closer()));
}
function editArtist(a) {
  const name = h('input', { value: a.name, maxlength: 200 }), desc = h('textarea', { rows: 4, maxlength: 2000 }, a.description || ''), art = artPicker(), err = h('p', { class: 'err', role: 'alert' });
  const d = dialog('Edit artist', h('label', {}, 'Name'), name, h('label', {}, 'About'), desc, h('label', {}, 'Picture'), art, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', `/artists/${a.id}`, { name: name.value, description: desc.value }); if (art.files[0]) await putArt('artist', a.id, art.files[0]); d.close(); await loadLibrary(); toast('Saved'); route(); } catch (x) { err.textContent = x.message; } } }, 'Save'),
    S.artistArt.get(a.id) ? h('button', { class: 'btn ghost', onclick: async () => { try { await api('PATCH', `/artists/${a.id}`, { removeArt: true }); d.close(); await loadLibrary(); route(); } catch (x) { err.textContent = x.message; } } }, 'Remove picture') : null, closer()));
}
function editAlbum(a, prof) {
  const title = h('input', { value: a.title }), desc = h('textarea', { rows: 4, maxlength: 2000 }, prof?.description || ''), art = artPicker(), err = h('p', { class: 'err', role: 'alert' });
  const d = dialog('Edit album', h('label', {}, 'Album title (renames it on all its songs)'), title, h('label', {}, 'Description'), desc, h('label', {}, 'Cover picture'), art, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try {
    const renamed = title.value.trim() && title.value.trim() !== a.title; let id = a.id;
    await api('PATCH', `/albums/${id}`, { description: desc.value }); if (art.files[0]) await putArt('album', id, art.files[0]); if (renamed) await api('POST', `/albums/${id}/rename`, { title: title.value.trim() });
    d.close(); await loadLibrary(); toast('Saved'); if (renamed) location.hash = '#/library'; else route(); } catch (x) { err.textContent = x.message; } } }, 'Save'), closer()));
}

// ---------------- Upload ----------------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (blob) => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
async function uploadFile(file, meta, art, setStatus, setProgress) {
  if (!crypto.subtle) throw new Error('Uploads need a secure (https) connection.');
  const P = S.meta.partSize, n = Math.ceil(file.size / P), hashes = [];
  setStatus('Checking…'); for (let i = 0; i < n; i++) hashes.push(await sha(file.slice(i * P, (i + 1) * P)));
  const start = await api('POST', '/uploads/start', { name: file.name, size: file.size, fingerprint: await sha(new Blob([hashes.join('')])) });
  if (start.duplicate) return { duplicate: start.duplicate.title };
  const parts = [];
  for (let i = 0; i < n; i++) {
    setStatus(`Uploading ${i + 1} of ${n}…`); const chunk = file.slice(i * P, (i + 1) * P); let last;
    for (let a = 0; a < 3; a++) { try { parts.push(await sendBytes(`/uploads/${start.uploadId}/parts/${i}`, chunk, { 'X-Chunk-Sha256': hashes[i] })); last = null; break; } catch (e) { last = e; if (e.status && e.status < 500 && e.code !== 'checksum_mismatch') break; await new Promise((r) => setTimeout(r, 800 * (a + 1))); } }
    if (last) throw last; setProgress((i + 1) / n);
  }
  let artTicket = null; if (art) { try { artTicket = await sendBytes(`/uploads/${start.uploadId}/art`, art); } catch { /* the song still uploads without art */ } }
  setStatus('Saving…'); return api('POST', `/uploads/${start.uploadId}/finish`, { name: file.name, size: file.size, parts, meta, ...(artTicket ? { art: artTicket } : {}) });
}
const uploadQueue = [];
function uploadView() {
  const input = h('input', { type: 'file', multiple: '', accept: 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav', 'aria-label': 'Choose audio files', style: 'display:none' }), cards = h('div', {}), go = h('button', { class: 'btn big', hidden: '' }, icon('upload'), 'Upload'), note = h('p', { class: 'fine muted' });
  const drop = h('div', { class: 'upl', ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); add([...e.dataTransfer.files]); } },
    icon('upload', 40), h('p', {}, 'Drag & drop your audio files here', h('br'), h('small', { class: 'muted' }, 'or')), h('button', { class: 'btn', onclick: () => input.click() }, 'Choose Files'), input, h('p', { class: 'fine muted' }, `Supports MP3, M4A, AAC, FLAC, OGG, WAV. Up to ${S.meta.maxFileMb} MB per song.`));
  async function add(files) {
    for (const file of files) {
      const [tags, dur] = await Promise.all([readTags(file), audioDuration(file)]), guess = guessFromName(file.name), tagName = tags.artists[0] || guess.artist;
      const match = tagName && S.artists.find((a) => norm(a.name) === norm(tagName)), pick = artistPicker(match ? [match.id] : []);
      const f = { title: h('input', { value: tags.title || guess.title, maxlength: 200, 'aria-label': 'Title' }), album: h('input', { value: tags.album, placeholder: 'Unknown album' }), genre: h('input', { value: tags.genre, placeholder: 'e.g. Afrobeats' }), tags: h('input', { placeholder: 'chill, 2022 (comma separated)' }) };
      const st = h('div', { class: 'st' }, dur === null ? 'This browser cannot decode this file; it may not play here.' : ''), bar = h('i');
      const item = { file, tags, dur, f, pick, st, bar, state: 'ready' };
      const hint = tagName && !match ? h('p', { class: 'fine' }, `The file says the artist is "${tagName}". `, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); const a = await newArtist(tagName); if (a) { pick.add(a.id); pick.redraw(); e.target.closest('p').remove(); } } }, `Create "${tagName}" as an artist`)) : null;
      item.el = h('div', { class: 'card upcard' }, h('div', { class: 'between' }, h('b', { class: 'ttl' }, file.name), h('button', { class: 'iconbtn', 'aria-label': 'Remove', onclick: () => { uploadQueue.splice(uploadQueue.indexOf(item), 1); item.el.remove(); sync(); } }, icon('x'))),
        h('label', {}, 'Title *'), f.title, h('label', {}, 'Artist'), pick.el, hint, h('div', { class: 'field-row' }, h('div', {}, h('label', {}, 'Album'), f.album), h('div', {}, h('label', {}, 'Genre'), f.genre)), h('label', {}, 'Tags'), f.tags, st, h('div', { class: 'prog' }, bar));
      uploadQueue.push(item); cards.append(item.el);
    }
    input.value = ''; sync();
  }
  const sync = () => { const n = uploadQueue.filter((i) => i.state !== 'done').length; go.hidden = !n; go.lastChild.textContent = n > 1 ? `Upload ${n} songs` : 'Upload'; note.textContent = S.tracks.length || uploadQueue.length ? `Storage used: ${fmtSize(S.used || 0)} of ${S.meta.libraryLimitMb} MB.` : ''; };
  go.onclick = async () => {
    go.disabled = true; let ok = 0; const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
    for (const it of [...uploadQueue]) {
      if (it.state === 'done') continue; const say = (m, c = '') => { it.st.textContent = m; it.st.className = `st ${c}`; };
      if (!it.f.title.value.trim()) { say('Add a title first.', 'bad'); continue; }
      try {
        const small = it.tags.picture ? await shrinkImage(new Blob([it.tags.picture.data], { type: it.tags.picture.mime })) : null;
        const meta = { title: it.f.title.value.trim(), artistIds: it.pick.get(), album: it.f.album.value.trim(), albumArtist: '', trackNo: it.tags.trackNo, discNo: it.tags.discNo, year: it.tags.year, genre: it.f.genre.value.trim(), tags: csv(it.f.tags.value), durationMs: it.dur || 0 };
        const r = await uploadFile(it.file, meta, small && small.size < 2 * 1024 * 1024 ? small : null, (m) => say(m), (p) => { it.bar.style.width = `${Math.round(p * 100)}%`; });
        if (r.duplicate) { say(`Already in your library as "${r.duplicate}". Skipped.`, 'bad'); it.state = 'done'; } else { ok++; it.state = 'done'; it.bar.style.width = '100%'; say('Added ✓', 'ok'); }
      } catch (e) { say(e.message || 'Upload failed', 'bad'); }
    }
    go.disabled = false; if (ok) { await loadLibrary(); toast(`${plural(ok, 'song')} added`); } sync();
  };
  input.onchange = () => add([...input.files]);
  frame('upload', backbar(h('h1', { style: 'margin:0' }, 'Upload Music'), h('div', { style: 'flex:1' })), drop, h('h2', { class: 'sec' }, 'Add Details'), uploadQueue.length ? null : h('p', { class: 'muted fine' }, 'Choose files above, then check each song\'s details. Artists are never created automatically: pick one of yours, create one, or leave it as Unknown artist.'), cards, go, note);
  for (const it of uploadQueue) cards.append(it.el); sync();
}

// ---------------- Analytics ----------------
async function statsView() {
  const tz = -new Date().getTimezoneOffset(), body = h('div', {}), ranges = [['7d', '7 Days'], ['30d', '30 Days'], ['3m', '3 Months'], ['1y', '1 Year'], ['custom', 'Custom']];
  const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const load = async (cf, ct) => {
    body.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); let q = `range=${{ '7d': 'week', '30d': 'month', '1y': 'year' }[S.range] || 'custom'}`;
    if (S.range === '3m') { const e = new Date(), s0 = new Date(); s0.setDate(e.getDate() - 89); q += `&from=${dstr(s0)}&to=${dstr(e)}`; } else if (S.range === 'custom') q += `&from=${cf}&to=${ct}`;
    try { draw(await api('GET', `/stats?${q}&tz=${tz}&limit=10`)); } catch (x) { body.replaceChildren(h('p', { class: 'err' }, x.message)); }
  };
  const draw = (s) => {
    const max = Math.max(1, ...s.byDay.map((d) => d.listenMs)), nod = s.byDay.filter((d) => d.noData).length, maxA = Math.max(1, ...s.topArtists.map((a) => a.plays)), maxT = Math.max(1, ...s.topTracks.map((a) => a.plays));
    body.replaceChildren(!s.coverage.hasAnyData ? emptyState('No listening recorded yet. Play some music and check back.') : h('div', {},
      h('div', { class: 'stat-grid' }, [['Total Listening Time', fmtDur(s.totals.listenMs)], ['Total Plays', s.totals.plays], ['Unique Artists', s.totals.uniqueArtists]].map(([l, v]) => h('div', { class: 'stat' }, h('span', {}, l), h('b', {}, v)))),
      h('div', { class: 'bars', role: 'img', 'aria-label': 'Listening time per day' }, s.byDay.map((d) => h('i', { class: d.noData ? 'nod' : '', style: d.noData ? '' : `height:${Math.max(3, Math.round((d.listenMs / max) * 100))}%`, title: d.noData ? `${d.date}: no data` : `${d.date}: ${plural(d.plays, 'play')}` }))),
      h('p', { class: 'fine muted' }, nod ? `Hatched bars = no data: listening was not tracked before ${new Date(s.coverage.trackingSince).toLocaleDateString()}. That is not the same as zero plays.` : `Tracking since ${new Date(s.coverage.trackingSince).toLocaleDateString()}.`),
      h('h2', { class: 'sec' }, 'Top Artists'), h('div', { class: 'rows' }, s.topArtists.slice(0, 5).map((a, i) => h('div', { class: 'row-t static' }, h('span', { class: 'num' }, i + 1), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, a.name), h('div', { class: 'meter' }, h('i', { style: `width:${(a.plays / maxA) * 100}%` }))), h('span', { class: 'dur' }, plural(a.plays, 'play'))))),
      h('h2', { class: 'sec' }, 'Top Songs'), h('div', { class: 'rows' }, s.topTracks.slice(0, 5).map((x, i) => { const t = S.byId.get(x.trackId); return t ? trackRow(t, s.topTracks.map((y) => S.byId.get(y.trackId)).filter(Boolean), i, { numbered: true, extra: h('span', { class: 'dur' }, plural(x.plays, 'play')) }) : null; })),
      s.topGenres.length ? h('div', {}, h('h2', { class: 'sec' }, 'Top Genres'), s.topGenres.map((g) => h('span', { class: 'chip', style: 'margin:0 .3rem .3rem 0;display:inline-block' }, `${g.name} · ${g.plays}`))) : null));
  };
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' }), custom = h('div', { class: 'searchbar', hidden: S.range === 'custom' ? null : '' }, from, to, h('button', { class: 'btn', onclick: () => from.value && to.value && load(from.value, to.value) }, 'Show'));
  frame('stats', h('div', { class: 'top' }, h('h1', {}, 'Analytics')), h('div', { class: 'chips' }, ranges.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': S.range === k ? 'true' : 'false', onclick: (e) => { S.range = k; document.querySelectorAll('.chips .chip').forEach((c) => c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false')); custom.hidden = k !== 'custom'; if (k !== 'custom') load(); } }, l))), custom, body,
    h('p', { class: 'fine muted' }, 'A play counts after 30 seconds of real listening (or half of a short track). Starts under 3 seconds are ignored.'));
  load(S.range === 'custom' ? undefined : undefined);
}

// ---------------- More ----------------
async function moreView() {
  const u = await offline.usage().catch(() => ({ bytes: 0 })), row = (ic, label, val, fn) => h('button', { class: 'setrow', onclick: fn }, icon(ic), h('span', { class: 'meta' }, label), val ? h('span', { class: 'muted' }, val) : null, icon('chevright'));
  frame('more', h('div', { class: 'top' }, h('h1', {}, 'Settings')), h('div', { class: 'profile' }, h('img', { class: 'logo big', src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('div', { class: 'meta' }, h('b', {}, S.me.user.displayName), h('small', { class: 'muted' }, S.me.user.email || ''))),
    h('div', { class: 'setlist' }, row('download', 'Offline Downloads', plural(S.offline.size, 'song'), () => { location.hash = '#/downloads'; }), row('box', 'Storage Usage', `${fmtSize(S.used || 0)} / ${S.meta.libraryLimitMb} MB`, () => toast(`Library ${fmtSize(S.used || 0)}. On this device: ${fmtSize(u.bytes)} downloaded. Storage: ${S.meta.storage === 'github' ? 'private GitHub branch' : 'local files'}.`)),
      S.meta.can.write ? row('upload', 'Add music', '', () => { location.hash = '#/upload'; }) : null, S.meta.can.ai ? row('sparkle', 'Ask Nebula', '', openNebula) : null, row('file', 'Export library list', 'no audio', async () => { const j = await api('GET', '/export'); h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' })), download: 'jupiter-library.json' }).click(); }),
      S.meta.can.maintain ? row('settings', 'Storage upkeep', '', maintenance) : null, canPromptInstall() && !isStandalone() ? row('phone', 'Install Jupiter', '', promptInstall) : null, row('home', 'Universe dashboard', '', () => { location.href = '/dashboard/'; }), row('target', 'About Jupiter', 'v1.1.0', () => toast('Jupiter · part of Universe · Hie Technologies'))),
    h('button', { class: 'btn ghost danger wide', onclick: async () => { try { await rootApi('POST', '/api/auth/logout'); } catch { /* already out */ } S.me = null; boot(); } }, 'Sign Out'));
}
async function maintenance() {
  const st = await api('GET', '/maintenance/status'), msg = h('p', { class: 'fine muted' }, `Branch: ${st.branch || 'n/a'}. History is squashed weekly (${st.cronConfigured ? 'cron secret set' : 'CRON_SECRET not set: weekly job inactive'}). GitHub may keep old commits reachable until it cleans them up.`);
  const d = dialog('Storage upkeep', msg, h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: async () => { try { const r = await api('GET', '/maintenance/orphans'); msg.textContent = `${r.files} files; ${r.orphanCount} unreferenced; ${r.missingCount} referenced but missing. Report only; nothing deleted.`; } catch (x) { toast(x.message); } } }, 'Check files'),
    h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Squash the music branch history now? All songs and artwork are kept.')) return; try { const r = await api('POST', '/maintenance/rebuild-history?confirm=true'); toast(r.skipped || 'History rebuilt'); } catch (x) { toast(x.message); } } }, 'Rebuild history now'), closer()));
}

// ---------------- mini player and Now Playing ----------------
let mini, np;
function drawMini() {
  mini?.remove(); mini = null; const t = pl.current(); if (!t) return;
  const bar = h('div', { class: 'bar' }), play = h('button', { class: 'iconbtn', 'aria-label': 'Play or pause', onclick: (e) => { e.stopPropagation(); pl.toggle(); } });
  mini = h('div', { class: 'mini', role: 'group', 'aria-label': 'Player', onclick: openNow }, artEl(artKeyOf(t)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, t.title), h('div', { class: 'sub2' }, t.artists.join(', '))), play, h('button', { class: 'iconbtn', 'aria-label': 'Next', onclick: (e) => { e.stopPropagation(); pl.next(); } }, icon('next')), bar);
  mini._upd = () => { const s = pl.state(); play.replaceChildren(icon(s.playing ? 'pause' : 'play')); bar.style.width = s.dur ? `${(s.pos / s.dur) * 100}%` : '0'; }; mini._upd(); document.body.append(mini);
}
function drawNow() { if (np) openNow(true); }
function openNow(redraw) {
  const t = pl.current(); if (!t) return; if (np && redraw !== true) return; np?.remove();
  const seek = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, 'aria-label': 'Seek', oninput: (e) => { const s = pl.state(); if (s.dur) pl.seek((e.target.value / 1000) * s.dur); } }), cur = h('span', {}, '0:00'), tot = h('span', {}, fmtTime(t.durationMs));
  const playBtn = h('button', { class: 'iconbtn play', 'aria-label': 'Play or pause', onclick: pl.toggle }), shuf = h('button', { class: 'iconbtn', 'aria-label': 'Shuffle', onclick: () => pl.setShuffle(!pl.P.shuffle) }, icon('shuffle')), rep = h('button', { class: 'iconbtn', 'aria-label': 'Repeat', onclick: pl.cycleRepeat }, icon('repeat'));
  const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round(pl.P.volume * 100), 'aria-label': 'Volume', oninput: (e) => pl.setVolume(e.target.value / 100) }), queue = h('div', { class: 'rows queue' });
  const drawQueue = () => { const upNext = pl.P.queue.map((id, i) => [id, i]).filter(([, i]) => i > pl.P.index); queue.replaceChildren(h('h2', { class: 'sec' }, 'Up Next', h('span', { class: 'fine muted' }, plural(upNext.length, 'song'))), upNext.map(([id, i]) => { const q = S.byId.get(id) || pl.P.tracks.get(id); if (!q) return null; return h('div', { class: 'row-t', onclick: () => pl.jump(i) }, artEl(artKeyOf(q)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, q.title), h('div', { class: 'sub2' }, q.artists.join(', '))),
    h('span', { style: 'display:flex' }, h('button', { class: 'iconbtn', 'aria-label': 'Move up', onclick: (e) => { e.stopPropagation(); pl.moveInQueue(i, -1); } }, icon('up')), h('button', { class: 'iconbtn', 'aria-label': 'Move down', onclick: (e) => { e.stopPropagation(); pl.moveInQueue(i, 1); } }, icon('down')), h('button', { class: 'iconbtn', 'aria-label': 'Remove from queue', onclick: (e) => { e.stopPropagation(); pl.removeFromQueue(i); } }, icon('x')))); })); };
  const dl = S.offline.has(t.id) ? h('button', { class: 'iconbtn on', 'aria-label': 'Downloaded', title: 'Available offline', onclick: () => toast('Available offline') }, icon('check')) : h('button', { class: 'iconbtn', 'aria-label': 'Download for offline', onclick: () => startDownload(t) }, icon('download'));
  np = h('div', { class: 'np', role: 'dialog', 'aria-label': 'Now playing' }, h('div', { class: 'head' }, h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: closeNow }, icon('chevdown')), h('b', {}, 'Now playing'), h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: () => trackMenu(t) }, icon('more'))),
    h('div', { class: 'cover' }, artEl(artKeyOf(t), { cls: 'big' })), h('div', { class: 'side-col' }, h('div', { class: 'npmeta' }, h('h2', {}, t.title), h('div', { class: 'artist' }, t.artists.join(', ')), h('div', { class: 'muted fine' }, t.album)),
      seek, h('div', { class: 'times' }, cur, tot), h('div', { class: 'ctl' }, shuf, h('button', { class: 'iconbtn', 'aria-label': 'Previous', onclick: () => pl.prev() }, icon('prev')), playBtn, h('button', { class: 'iconbtn', 'aria-label': 'Next', onclick: () => pl.next() }, icon('next')), rep),
      h('div', { class: 'ctl two' }, h('button', { class: `iconbtn ${t.liked ? 'on' : ''}`, 'aria-label': 'Like', onclick: () => toggleLike(t) }, icon('heart')), dl, h('button', { class: 'iconbtn', 'aria-label': 'Add to playlist', onclick: () => addToPlaylist([t.id]) }, icon('plus'))), h('div', { class: 'vol' }, icon('vol'), vol), queue));
  np._upd = () => { const s = pl.state(); playBtn.replaceChildren(icon(s.playing ? 'pause' : 'play')); if (s.dur && document.activeElement !== seek) seek.value = Math.round((s.pos / s.dur) * 1000); cur.textContent = fmtTime(s.pos * 1000); if (s.dur) tot.textContent = fmtTime(s.dur * 1000); shuf.classList.toggle('on', pl.P.shuffle); rep.classList.toggle('on', pl.P.repeat !== 'off'); rep.title = `Repeat: ${pl.P.repeat}`; };
  np._upd(); drawQueue(); np._q = drawQueue; document.body.append(np);
}
function closeNow() { np?.remove(); np = null; }
let lastTrack = null;
pl.on(() => { mini?._upd?.(); np?._upd?.(); const c = pl.current()?.id; if (c !== lastTrack) { lastTrack = c; if (np) openNow(true); drawMini(); root.className = c ? '' : 'has-no-mini'; document.title = pl.current() ? `${pl.current().title} · Jupiter` : 'Jupiter'; } else np?._q?.(); });

// ---------------- Nebula ----------------
let neb = null;
function openNebula() {
  if (neb) return; const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' }), input = h('textarea', { rows: 1, enterkeyhint: 'send', placeholder: 'Ask Nebula…', 'aria-label': 'Message Nebula' }), send = h('button', { class: 'btn round', 'aria-label': 'Send' }, icon('send'));
  const add = (cls, ...k) => { const m = h('div', { class: `msg ${cls}` }, ...k); log.append(m); log.scrollTop = log.scrollHeight; return m; };
  const submit = async (text) => {
    text = (text ?? input.value).trim(); if (!text) return; input.value = ''; hideSugg(); add('user', text); const wait = add('assistant', '…'); send.disabled = true;
    try { const r = await rootApi('POST', '/api/ai/chat', { message: text, ...(S.conv ? { conversationId: S.conv } : {}), clientContext: pl.snapshot() }); S.conv = r.conversation.id; wait.replaceChildren(renderMarkdown(r.reply.content, h)); for (const a of r.actions || []) if (a.app === 'jupiter') await runAction(a, log); }
    catch (x) { wait.replaceChildren(x.message); } finally { send.disabled = false; log.scrollTop = log.scrollHeight; }
  };
  send.onclick = () => submit(); input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null;
  const mic = SR ? h('button', { class: 'iconbtn mic', 'aria-label': 'Speak', onclick: () => { if (rec) { rec.stop(); return; } rec = new SR(); rec.lang = navigator.language; rec.onresult = (e) => { input.value = e.results[0][0].transcript; submit(); }; rec.onend = () => { rec = null; mic.classList.remove('on'); }; rec.onerror = () => { rec = null; mic.classList.remove('on'); }; mic.classList.add('on'); rec.start(); } }, icon('mic')) : null;
  const sugg = ['Play my favourite Afrobeats.', 'Create a playlist for late-night studying.', 'Play everything by …', 'What have I been listening to lately?', 'Show my top artists this month.'];
  const suggBox = h('div', { class: 'sugg' }, sugg.map((s) => h('button', { class: 'pill', onclick: () => (s.endsWith('…') ? (input.value = s.slice(0, -1), input.focus()) : submit(s)) }, icon('message'), s)));
  const hideSugg = () => suggBox.remove();
  neb = h('div', { class: 'neb', role: 'dialog', 'aria-label': 'Nebula' }, h('div', { class: 'nebhead' }, h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => { neb.remove(); neb = null; } }, icon('chevdown')), h('img', { class: 'logo big', src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('div', { class: 'meta' }, h('b', {}, 'Nebula ', h('span', { class: 'badge' }, 'Beta')), h('small', { class: 'muted' }, 'Your AI music assistant. Ask me anything about your music.'))),
    log, suggBox, h('div', { class: 'in' }, mic, input, send));
  document.body.append(neb); input.focus();
}
// The browser only runs these fixed action types, and only for tracks that exist in the library it just loaded.
async function runAction(a, log) {
  if (a.type === 'play') {
    const tracks = songs(a.trackIds || []); if (!tracks.length) { toast('Those songs are not in your library.'); return; }
    if (a.mode === 'next' || a.mode === 'append') { pl.enqueue(tracks, a.mode === 'next' ? 'next' : 'append'); toast(`Queued ${tracks.length}`); } else { pl.playList(tracks, 0, { src: 'nebula', shuffle: !!a.shuffle }); toast(`Playing ${a.label || 'your music'}`); }
  } else if (a.type === 'control') {
    const m = { pause: () => pl.pause(), resume: () => pl.resume(), next: () => pl.next(), previous: () => pl.prev(), shuffleOn: () => pl.setShuffle(true), shuffleOff: () => pl.setShuffle(false), repeatOff: () => pl.setRepeat('off'), repeatOne: () => pl.setRepeat('one'), repeatAll: () => pl.setRepeat('all'),
      seek: () => pl.seek(Number(a.value)), volume: () => pl.setVolume(Number(a.value) / 100), like: () => pl.current() && !pl.current().liked && toggleLike(pl.current()), unlike: () => pl.current()?.liked && toggleLike(pl.current()) };
    m[a.action]?.();
  } else if (a.type === 'refresh' || a.type === 'openPlaylist') { await loadLibrary(); route(); } else if (a.type === 'confirm') {
    const box = h('div', { class: 'msg assistant confirm' }, h('p', {}, a.action === 'deleteTrack' ? `Delete "${a.title}" by ${a.artist} permanently?` : a.action === 'deletePlaylist' ? `Delete the playlist "${a.title}"? Its songs stay in your library.` : `Clear all songs from "${a.title}"? The songs stay in your library.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async (e) => { e.currentTarget.disabled = true; try {
        if (a.action === 'deleteTrack') { await api('DELETE', `/tracks/${a.trackId}?confirm=true`); await offline.remove(a.trackId).catch(() => {}); } else if (a.action === 'deletePlaylist') await api('DELETE', `/playlists/${a.playlistId}?confirm=true`); else await api('PUT', `/playlists/${a.playlistId}/tracks`, { trackIds: [] });
        await loadLibrary(); await refreshOffline(); box.replaceChildren('Done.'); route(); } catch (x) { box.replaceChildren(x.message); } } }, 'Yes, do it'), h('button', { class: 'btn ghost', onclick: () => box.replaceChildren('Cancelled. Nothing was changed.') }, 'Cancel'))); log.append(box);
  }
}

// ---------------- routing, splash and boot ----------------
async function route() {
  if (!S.me && !S.offlineMode) return; const [, page = '', arg] = (location.hash || '#/').split('/');
  try {
    if (S.offlineMode) return await downloadsView();
    if (page === 'library') libraryView(); else if (page === 'artists') artistsView(); else if (page === 'artist') artistView(arg); else if (page === 'album') albumView(arg); else if (page === 'playlist') playlistView(arg);
    else if (page === 'upload') uploadView(); else if (page === 'downloads') await downloadsView(); else if (page === 'stats') await statsView(); else if (page === 'more') await moreView(); else homeView();
  } catch (x) { if (x.status === 401) return; frame('home', topbar('Jupiter'), h('p', { class: 'err', role: 'alert' }, `Something went wrong: ${x.message}`), h('button', { class: 'btn ghost', onclick: route }, 'Try again')); }
}
const splash = () => new Promise((res) => { root.className = ''; root.replaceChildren(h('div', { class: 'splash' }, h('img', { class: 'hero-logo', src: '/apps/jupiter/icons/icon-512.png', alt: 'Jupiter' }), h('h1', {}, 'Jupiter'), h('p', {}, 'Your Music. Your Universe.'), h('button', { class: 'btn big', onclick: res }, 'Get Started'), h('div', { class: 'foot' }, icon('grid'), 'UNIVERSE'))); });
async function boot(note = '') {
  try { S.me = await rootApi('GET', '/api/auth/me'); }
  catch (e) {
    if (!e.status) { // no connection at all: offline mode with downloaded tracks only
      S.offlineMode = true; S.meta = { can: {}, partSize: 0 }; await refreshOffline(); const metas = (await offline.list()).filter((m) => m.done); for (const m of metas) { const t = { artistIds: [], artists: ['Unknown artist'], tags: [], ...m.track }; S.byId.set(m.id, t); pl.P.tracks.set(m.id, t); } S.tracks = metas.map((m) => S.byId.get(m.id)); S.me = { user: { displayName: 'you' } }; return route();
    }
    if (!note) await splash(); S.me = await showAuth({ root, brand, note });
  }
  S.offlineMode = false;
  try { S.meta = await api('GET', '/meta'); }
  catch (x) { if (x.status === 401) return; frame('home', h('h1', {}, 'Jupiter'), h('p', { class: 'muted' }, x.status === 403 ? 'Your account does not have access to Jupiter yet. Ask an admin to grant the jupiter permissions.' : `Jupiter could not load: ${x.message}`), h('button', { class: 'btn ghost', onclick: () => { S.me = null; boot(); } }, 'Sign out')); return; }
  await Promise.all([loadLibrary(), refreshOffline()]); pl.restore(S.byId); pl.flushEvents(); await route();
}
addEventListener('hashchange', () => { if (S.me) route(); });
addEventListener('online', () => { if (S.offlineMode) { S.me = null; boot(); } });
addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName; if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey || !pl.current()) return;
  if (e.code === 'Space') { e.preventDefault(); pl.toggle(); } else if (e.key === 'ArrowRight') { e.shiftKey ? pl.seek(pl.state().pos + 10) : pl.next(); } else if (e.key === 'ArrowLeft') { e.shiftKey ? pl.seek(pl.state().pos - 10) : pl.prev(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pl.setVolume(pl.P.volume + 0.05); } else if (e.key === 'ArrowDown') { e.preventDefault(); pl.setVolume(pl.P.volume - 0.05); } else if (e.key === 'm') pl.setVolume(pl.P.volume ? 0 : 1); else if (e.key === 'Escape') closeNow();
});
boot();
