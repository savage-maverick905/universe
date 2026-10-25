// Jupiter: your own music, in your own pocket. Installable app with its own sign-in, mini-player, Now Playing, offline downloads and Nebula.
import { api, h, toast, dialog, closer, B, sendBytes, fmtTime, fmtHours, fmtSize, setUnauthorizedHandler } from './services/api.js';
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
const S = { me: null, meta: null, tracks: [], byId: new Map(), playlists: [], albums: [], artists: [], albumArt: new Map(), artistArt: new Map(), offline: new Set(), dl: {}, offlineMode: false, q: '', tab: 'songs', filters: { genre: '', tag: '', liked: false, sort: 'recent' }, conv: null };
const brand = { name: 'Jupiter', blurb: 'Your own music, in your own pocket.', mark: () => h('img', { class: 'logo', src: '/apps/jupiter/icons/icon-192.png', alt: '' }) };
setUnauthorizedHandler(() => { if (S.me) { S.me = null; boot('Your session ended. Sign in again.'); } });
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const artKeyOf = (t) => t.artKey || S.albumArt.get(t.albumId) || (t.artistIds || []).map((i) => S.artistArt.get(i)).find(Boolean) || null;
const artUrl = (k) => (k ? `${B}/art/${k}` : null);
function artEl(key, { cls = '', ic = 'music', blue = false } = {}) { const a = h('div', { class: `art ${cls} ${blue ? 'blue' : ''}` }); if (key && !S.offlineMode) a.append(h('img', { src: artUrl(key), alt: '', loading: 'lazy', onerror: (e) => e.target.remove() })); else a.append(icon(ic)); return a; }
pl.P.getArt = (t) => (artKeyOf(t) ? new URL(artUrl(artKeyOf(t)), location.origin).href : null);
pl.P.onError = (m) => toast(m);

async function loadLibrary() {
  const lib = await api('GET', '/library');
  S.tracks = lib.tracks; S.playlists = lib.playlists; S.albums = lib.albums; S.artists = lib.artists; S.used = lib.used;
  S.byId = new Map(S.tracks.map((t) => [t.id, t])); S.albumArt = new Map(S.albums.filter((a) => a.artKey).map((a) => [a.id, a.artKey])); S.artistArt = new Map(S.artists.filter((a) => a.artKey).map((a) => [a.id, a.artKey]));
  for (const t of S.tracks) pl.P.tracks.set(t.id, t);
}
async function refreshOffline() { S.offline = await offline.completeIds(); pl.P.offlineIds = S.offline; }
const songs = (ids) => ids.map((i) => S.byId.get(i)).filter(Boolean);
const by = (arr, f) => { const m = new Map(); for (const x of arr) for (const k of [].concat(f(x))) { if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const albumsList = () => [...by(S.tracks, (t) => t.albumId)].map(([id, ts]) => ({ id, title: ts[0].album, artist: ts[0].albumArtist || ts[0].artists[0], tracks: ts.sort((a, b) => (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 0) - (b.trackNo || 0)), key: S.albumArt.get(id) || ts.find((t) => t.artKey)?.artKey })).sort((a, b) => a.title.localeCompare(b.title));
const artistsList = () => { const m = new Map(); for (const t of S.tracks) t.artists.forEach((n, i) => { const id = t.artistIds[i]; if (!m.has(id)) m.set(id, { id, name: n, tracks: [] }); m.get(id).tracks.push(t); }); return [...m.values()].sort((a, b) => a.name.localeCompare(b.name)); };

// ---------------- shell ----------------
const NAV = [['#/', 'Home', 'home', 'home'], ['#/library', 'Library', 'library', 'music'], ['#/upload', 'Add', 'upload', 'plus'], ['#/downloads', 'Downloads', 'downloads', 'download'], ['#/stats', 'Stats', 'stats', 'chart']];
function frame(page, ...content) {
  const link = ([href, text, id, ic]) => h('a', { href, 'aria-current': page === id ? 'page' : null }, icon(ic), h('span', {}, text));
  const nav = S.offlineMode ? [NAV[3]] : NAV;
  root.className = pl.current() ? '' : 'has-no-mini';
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('a', { class: 'brand', href: '#/' }, h('img', { src: '/apps/jupiter/icons/icon-192.png', alt: '' }), 'Jupiter'), nav.map(link), h('div', { style: 'flex:1' }), h('a', { href: '#', onclick: (e) => { e.preventDefault(); moreMenu(); } }, icon('settings'), h('span', {}, 'More'))),
    h('main', { class: 'main' }, S.offlineMode ? h('div', { class: 'offline-banner' }, 'Offline mode: only tracks you downloaded can play.') : null, ...content),
    h('nav', { class: 'bottom', 'aria-label': 'Main' }, nav.map(link))));
  window.scrollTo(0, 0); drawMini();
}
const topbar = (title, ...extra) => h('div', { class: 'top' }, h('img', { class: 'logo', src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('h1', {}, title), ...extra,
  S.meta?.can.ai && !S.offlineMode ? h('button', { class: 'iconbtn', title: 'Ask Nebula', 'aria-label': 'Ask Nebula', onclick: openNebula }, icon('sparkle')) : null,
  h('button', { class: 'iconbtn', title: 'More', 'aria-label': 'More', onclick: moreMenu }, icon('more')));

// ---------------- track rows and menus ----------------
function trackRow(t, list, i, { src = 'library', extra } = {}) {
  const now = pl.current()?.id === t.id;
  return h('div', { class: `row-t ${now ? 'now' : ''}`, onclick: () => pl.playList(list, i, { src }) },
    artEl(artKeyOf(t)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, t.title, S.offline.has(t.id) ? h('span', { class: 'tag' }, 'offline') : null), h('div', { class: 'sub2' }, `${t.artists.join(', ')} · ${t.album}`)),
    h('span', { class: 'dur' }, t.durationMs ? fmtTime(t.durationMs) : ''), extra || null,
    h('button', { class: `iconbtn ${t.liked ? 'on' : ''}`, 'aria-label': t.liked ? 'Unlike' : 'Like', onclick: (e) => { e.stopPropagation(); toggleLike(t); } }, icon('heart')),
    h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: (e) => { e.stopPropagation(); trackMenu(t); } }, icon('more')));
}
async function toggleLike(t) { try { const r = await api('PATCH', `/tracks/${t.id}`, { liked: !t.liked }); Object.assign(t, r.track); route(); drawNow(); } catch (x) { toast(x.message); } }
function trackMenu(t) {
  const d = dialog(t.title, h('p', { class: 'sub' }, t.artists.join(', ')), h('div', { class: 'menu' },
    mi('play', 'Play next', () => { pl.enqueue([t], 'next'); toast('Playing next'); }), mi('queue', 'Add to queue', () => { pl.enqueue([t]); toast('Added to queue'); }),
    S.meta.can.write ? mi('plus', 'Add to playlist', () => addToPlaylist([t.id])) : null,
    S.offline.has(t.id) ? mi('trash', 'Remove download', async () => { await offline.remove(t.id); await refreshOffline(); route(); toast('Download removed'); }) : (S.dl[t.id] != null ? null : mi('download', 'Download for offline', () => startDownload(t))),
    S.meta.can.write ? mi('pencil', 'Edit details and artwork', () => editTrack(t)) : null, mi('disc', 'Go to album', () => { location.hash = `#/album/${t.albumId}`; }), mi('user', 'Go to artist', () => { location.hash = `#/artist/${t.artistIds[0]}`; }),
    S.meta.can.delete ? mi('trash', 'Delete music file…', () => confirmDeleteTrack(t), 'danger') : null), closer());
  function mi(ic, text, fn, cls = '') { return h('button', { class: cls, onclick: () => { d.close(); fn(); } }, icon(ic), text); }
}
async function confirmDeleteTrack(t) {
  const d = dialog('Delete this song?', h('p', {}, `"${t.title}" will be deleted from your storage permanently. Playlists lose it too. This cannot be undone.`), h('div', { class: 'actions' },
    h('button', { class: 'btn danger', onclick: async () => { try { await api('DELETE', `/tracks/${t.id}?confirm=true`); if (S.offline.has(t.id)) await offline.remove(t.id); d.close(); await loadLibrary(); await refreshOffline(); toast('Deleted'); route(); } catch (x) { toast(x.message); } } }, 'Delete forever'), closer('Keep it')));
}
function addToPlaylist(ids) {
  const d = dialog('Add to playlist', h('div', { class: 'menu' }, S.playlists.map((p) => h('button', { onclick: async () => { try { await api('POST', `/playlists/${p.id}/tracks`, { trackIds: ids }); d.close(); await loadLibrary(); toast(`Added to ${p.name}`); route(); } catch (x) { toast(x.message); } } }, icon('queue'), p.name)),
    h('button', { onclick: () => { d.close(); newPlaylist(ids); } }, icon('plus'), 'New playlist…')), closer());
}
function newPlaylist(ids = []) {
  const name = h('input', { placeholder: 'Playlist name', maxlength: 100, 'aria-label': 'Playlist name' });
  const d = dialog('New playlist', name, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/playlists', { name: name.value || 'New playlist', trackIds: ids }); d.close(); await loadLibrary(); location.hash = `#/playlist/${r.playlist.id}`; } catch (x) { toast(x.message); } } }, 'Create'), closer()));
  name.focus();
}

// ---------------- downloads ----------------
async function startDownload(t) {
  if (S.dl[t.id] != null) return; S.dl[t.id] = 0; toast('Downloading…');
  try { await offline.download(t, { base: B, partSize: S.meta.partSize, artUrl: artKeyOf(t) ? artUrl(artKeyOf(t)) : null, onProgress: (p) => { S.dl[t.id] = p; if (location.hash === '#/downloads') drawDlProgress(); } }); toast(`"${t.title}" is available offline`); }
  catch (e) { toast(e.missing ? 'That file is missing from storage.' : e.quota ? e.message : `Download failed: ${e.message}`); }
  delete S.dl[t.id]; await refreshOffline(); route();
}
const drawDlProgress = () => { for (const [id, p] of Object.entries(S.dl)) { const el = document.querySelector(`[data-dl="${id}"] i`); if (el) el.style.width = `${Math.round(p * 100)}%`; } };
async function downloadsView() {
  const metas = (await offline.list()), done = metas.filter((m) => m.done), u = await offline.usage();
  const items = done.map((m) => m.track), active = Object.keys(S.dl).map((id) => S.byId.get(id) || metas.find((m) => m.id === id)?.track).filter(Boolean);
  frame('downloads', topbar('Downloads'),
    h('p', { class: 'sub' }, `${done.length} track${done.length === 1 ? '' : 's'} saved on this device (${fmtSize(u.bytes)}).${u.quota ? ` Browser allows about ${fmtSize(u.quota)}.` : ''} ${u.persisted ? 'Storage is marked persistent.' : 'The browser may clear this storage if the device runs low.'}`),
    active.length ? h('div', {}, h('h2', { class: 'sec' }, 'Downloading'), active.map((t) => h('div', { class: 'row-t', 'data-dl': t.id }, artEl(null), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, t.title), h('div', { class: 'prog' }, h('i', { style: `width:${Math.round((S.dl[t.id] || 0) * 100)}%` }))), h('span', { class: 'dur' }, 'saving…')))) : null,
    items.length ? h('div', { class: 'rows' }, items.map((t, i) => h('div', {}, trackRow({ ...(S.byId.get(t.id) || t), artistIds: t.artistIds || [] }, items, i, { src: 'downloads' })))) : h('div', { class: 'empty' }, 'Nothing downloaded yet. Open a song\'s ⋯ menu and choose "Download for offline". Only tracks you choose are saved.'),
    done.length ? h('div', { class: 'actions' }, h('button', { class: 'btn ghost danger', onclick: async () => { if (confirm('Remove all downloads from this device? Your library is not affected.')) { await offline.removeAll(); await refreshOffline(); route(); } } }, 'Remove all downloads')) : null,
    h('p', { class: 'fine muted' }, 'Downloads live in this browser\'s own storage, not in the page cache. Browsers can clear it under storage pressure, and iOS may clear it for sites you have not added to the Home Screen. Keep the original files safe; this is not a backup.'));
}

// ---------------- views ----------------
function homeView() {
  const recent = [...S.tracks].filter((t) => t.lastPlayedAt).sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt)).slice(0, 12), added = [...S.tracks].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 12), liked = S.tracks.filter((t) => t.liked);
  const tiles = (arr, src) => h('div', { class: 'scroller' }, arr.map((t, i) => h('div', { class: 'tile', onclick: () => pl.playList(arr, i, { src }) }, artEl(artKeyOf(t), { cls: 'big' }), h('div', { class: 'ttl' }, t.title), h('div', { class: 'sub2' }, t.artists.join(', ')))));
  frame('home', topbar('Jupiter'), h('div', { class: 'home-hello' }, h('img', { src: '/apps/jupiter/icons/icon-192.png', alt: '' }), h('div', {}, h('b', {}, `Hi ${S.me.user.displayName}`), h('div', { class: 'muted' }, S.tracks.length ? `${S.tracks.length} songs in your library.` : 'Your library is empty. Add the music you own to start.'))),
    S.tracks.length ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => pl.playList(S.tracks, 0, { src: 'library', shuffle: true }) }, icon('shuffle'), 'Shuffle all'), liked.length ? h('button', { class: 'btn ghost', onclick: () => pl.playList(liked, 0, { src: 'liked' }) }, icon('heart'), 'Liked songs') : null)
      : h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/upload' }, icon('upload'), 'Add music')),
    recent.length ? h('div', {}, h('h2', { class: 'sec' }, 'Recently played'), tiles(recent, 'library')) : null, added.length ? h('div', {}, h('h2', { class: 'sec' }, 'Recently added'), tiles(added, 'library')) : null,
    S.playlists.length ? h('div', {}, h('h2', { class: 'sec' }, 'Playlists'), h('div', { class: 'scroller' }, S.playlists.map((p) => h('div', { class: 'tile', onclick: () => { location.hash = `#/playlist/${p.id}`; } }, artEl(artKeyOf(songs(p.trackIds)[0] || {}), { cls: 'big', ic: 'queue', blue: true }), h('div', { class: 'ttl' }, p.name), h('div', { class: 'sub2' }, `${p.trackIds.length} songs`))))) : null);
}
function libraryView() {
  const f = S.filters, q = norm(S.q).split(/\s+/).filter(Boolean);
  const genres = [...new Set(S.tracks.map((t) => t.genre).filter(Boolean))].sort(), tags = [...new Set(S.tracks.flatMap((t) => t.tags))].sort();
  let rows = S.tracks.filter((t) => { const hay = norm([t.title, t.artists.join(' '), t.album, t.genre, t.tags.join(' ')].join(' ')); return q.every((x) => hay.includes(x)) && (!f.genre || t.genre === f.genre) && (!f.tag || t.tags.includes(f.tag)) && (!f.liked || t.liked); });
  const sorts = { recent: (a, b) => b.addedAt.localeCompare(a.addedAt), title: (a, b) => a.title.localeCompare(b.title), artist: (a, b) => a.artists[0].localeCompare(b.artists[0]), plays: (a, b) => b.playCount - a.playCount };
  rows = rows.sort(sorts[f.sort]);
  const search = h('input', { type: 'search', placeholder: 'Search songs, artists, albums, tags', value: S.q, 'aria-label': 'Search', oninput: (e) => { S.q = e.target.value; clearTimeout(search._t); search._t = setTimeout(() => { libraryView(); const i = document.querySelector('.searchbar input'); i?.focus(); i?.setSelectionRange(S.q.length, S.q.length); }, 180); } });
  const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { f[key] = e.target.value; libraryView(); } }, h('option', { value: '' }, label), opts.map((o) => h('option', { value: o, selected: f[key] === o ? '' : null }, o)));
  const tabs = ['songs', 'albums', 'artists', 'playlists'];
  let body;
  if (S.tab === 'songs') body = rows.length ? h('div', { class: 'rows' }, rows.map((t, i) => trackRow(t, rows, i, { src: S.q ? 'search' : 'library' }))) : h('div', { class: 'empty' }, S.tracks.length ? 'No songs match.' : 'No music yet.');
  else if (S.tab === 'albums') body = h('div', { class: 'grid' }, albumsList().filter((a) => !q.length || q.every((x) => norm(a.title + a.artist).includes(x))).map((a) => h('div', { class: 'tile', onclick: () => { location.hash = `#/album/${a.id}`; } }, artEl(a.key, { cls: 'big', ic: 'disc' }), h('div', { class: 'ttl' }, a.title), h('div', { class: 'sub2' }, a.artist))));
  else if (S.tab === 'artists') body = h('div', { class: 'grid' }, artistsList().filter((a) => !q.length || q.every((x) => norm(a.name).includes(x))).map((a) => h('div', { class: 'tile', onclick: () => { location.hash = `#/artist/${a.id}`; } }, artEl(S.artistArt.get(a.id) || a.tracks.find((t) => artKeyOf(t)) && artKeyOf(a.tracks.find((t) => artKeyOf(t))), { cls: 'big round', ic: 'user' }), h('div', { class: 'ttl' }, a.name), h('div', { class: 'sub2' }, `${a.tracks.length} songs`))));
  else body = h('div', { class: 'rows' }, S.meta.can.write ? h('div', { class: 'row-t', onclick: () => newPlaylist() }, h('div', { class: 'art blue' }, icon('plus')), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, 'New playlist'))) : null,
    S.playlists.map((p) => h('div', { class: 'row-t', onclick: () => { location.hash = `#/playlist/${p.id}`; } }, artEl(artKeyOf(songs(p.trackIds)[0] || {}), { ic: 'queue', blue: true }), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, p.name), h('div', { class: 'sub2' }, `${p.trackIds.length} songs`)))));
  frame('library', topbar('Library'), h('div', { class: 'chips' }, tabs.map((t) => h('button', { class: 'chip', 'aria-pressed': S.tab === t ? 'true' : 'false', onclick: () => { S.tab = t; libraryView(); } }, t[0].toUpperCase() + t.slice(1))), h('button', { class: 'chip', 'aria-pressed': f.liked ? 'true' : 'false', onclick: () => { f.liked = !f.liked; S.tab = 'songs'; libraryView(); } }, '♥ Liked')),
    h('div', { class: 'searchbar' }, search), S.tab === 'songs' ? h('div', { class: 'searchbar' }, sel('genre', genres, 'All genres'), sel('tag', tags, 'All tags'), h('select', { 'aria-label': 'Sort', onchange: (e) => { f.sort = e.target.value; libraryView(); } }, [['recent', 'Newest'], ['title', 'Title'], ['artist', 'Artist'], ['plays', 'Most played']].map(([v, l]) => h('option', { value: v, selected: f.sort === v ? '' : null }, l)))) : null, body);
}
function collectionPage(page, { title, subtitle, key, tracks, ic = 'music', round = false, onArt, blurb, extra }) {
  frame(page, h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => history.back() }, icon('back')), h('div', { style: 'flex:1' })),
    h('div', { class: 'hero' }, artEl(key, { ic, cls: round ? 'round' : '' }), h('div', {}, h('h1', {}, title), h('div', { class: 'muted' }, subtitle))), blurb ? h('p', { class: 'muted' }, blurb) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => pl.playList(tracks, 0, { src: page }) }, icon('play'), 'Play'), h('button', { class: 'btn ghost', onclick: () => pl.playList(tracks, 0, { src: page, shuffle: true }) }, icon('shuffle'), 'Shuffle'),
      onArt && S.meta.can.write ? h('button', { class: 'btn ghost', onclick: onArt }, icon('pencil'), 'Edit') : null),
    h('div', { class: 'rows' }, tracks.map((t, i) => trackRow(t, tracks, i, { src: page, extra: extra?.(t, i) }))));
}
function albumView(id) { const a = albumsList().find((x) => x.id === id); if (!a) return frame('library', topbar('Album'), h('div', { class: 'empty' }, 'Album not found.')); const prof = S.albums.find((x) => x.id === id);
  collectionPage('album', { title: a.title, subtitle: `${a.artist} · ${a.tracks.length} songs`, key: a.key, tracks: a.tracks, ic: 'disc', blurb: prof?.description, onArt: () => editProfile('album', id, a.title, prof) }); }
function artistView(id) { const a = artistsList().find((x) => x.id === id); if (!a) return frame('library', topbar('Artist'), h('div', { class: 'empty' }, 'Artist not found.')); const prof = S.artists.find((x) => x.id === id);
  collectionPage('artist', { title: a.name, subtitle: `${a.tracks.length} songs`, key: S.artistArt.get(id) || artKeyOf(a.tracks[0]), tracks: a.tracks.sort((x, y) => y.playCount - x.playCount), ic: 'user', round: true, blurb: prof?.description, onArt: () => editProfile('artist', id, a.name, prof) }); }
function playlistView(id) {
  const p = S.playlists.find((x) => x.id === id); if (!p) return frame('library', topbar('Playlist'), h('div', { class: 'empty' }, 'Playlist not found.'));
  const list = songs(p.trackIds), save = async (ids) => { try { await api('PUT', `/playlists/${p.id}/tracks`, { trackIds: ids }); await loadLibrary(); route(); } catch (x) { toast(x.message); } };
  const move = (i, d) => { const ids = [...p.trackIds]; const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; save(ids); };
  collectionPage('playlist', { title: p.name, subtitle: `${list.length} songs`, key: artKeyOf(list[0] || {}), tracks: list, ic: 'queue', blurb: p.description,
    extra: (t, i) => S.meta.can.write ? h('span', { style: 'display:flex' }, h('button', { class: 'iconbtn', 'aria-label': 'Move up', onclick: (e) => { e.stopPropagation(); move(i, -1); } }, icon('up')), h('button', { class: 'iconbtn', 'aria-label': 'Move down', onclick: (e) => { e.stopPropagation(); move(i, 1); } }, icon('down')),
      h('button', { class: 'iconbtn', 'aria-label': 'Remove from playlist', title: 'Remove from playlist (keeps the song)', onclick: (e) => { e.stopPropagation(); save(p.trackIds.filter((_, k) => k !== i)); } }, icon('x'))) : null });
  if (S.meta.can.write) document.querySelector('.actions').append(h('button', { class: 'btn ghost', onclick: () => renamePlaylist(p) }, 'Rename'), h('button', { class: 'btn ghost danger', onclick: () => confirmPlaylist(p, 'delete') }, 'Delete playlist'), list.length ? h('button', { class: 'btn ghost danger', onclick: () => confirmPlaylist(p, 'clear') }, 'Clear') : null);
}
function renamePlaylist(p) { const name = h('input', { value: p.name, maxlength: 100 }); const d = dialog('Rename playlist', name, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', `/playlists/${p.id}`, { name: name.value }); d.close(); await loadLibrary(); route(); } catch (x) { toast(x.message); } } }, 'Save'), closer())); }
function confirmPlaylist(p, what) {
  const del = what === 'delete'; const d = dialog(del ? 'Delete this playlist?' : 'Clear this playlist?', h('p', {}, del ? `"${p.name}" will be deleted. The ${p.trackIds.length} songs stay in your library.` : `All ${p.trackIds.length} songs will be removed from "${p.name}". The songs stay in your library.`),
    h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => { try { if (del) { await api('DELETE', `/playlists/${p.id}?confirm=true`); location.hash = '#/library'; } else await api('PUT', `/playlists/${p.id}/tracks`, { trackIds: [] }); d.close(); await loadLibrary(); route(); } catch (x) { toast(x.message); } } }, del ? 'Delete playlist' : 'Clear playlist'), closer('Cancel')));
}

// ---------------- editing ----------------
function artPicker() { const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }); return input; }
async function putArt(kind, id, file) { const small = (await shrinkImage(file)) || file; if (small.size > 2 * 1024 * 1024) throw new Error('That image is too large (2 MB max).'); return sendBytes(`/${kind}s/${id}/artwork`, small); }
function editTrack(t) {
  const f = (k, label, props = {}) => [h('label', {}, label), h('input', { value: t[k] ?? '', ...props })];
  const title = f('title', 'Title', { maxlength: 200 }), artists = [h('label', {}, 'Artists (comma separated)'), h('input', { value: t.artists.join(', ') })], album = f('album', 'Album'), aa = f('albumArtist', 'Album artist'), genre = f('genre', 'Genre');
  const tn = f('trackNo', 'Track no.', { type: 'number', min: 1 }), dn = f('discNo', 'Disc no.', { type: 'number', min: 1 }), yr = f('year', 'Year', { type: 'number' }), rd = f('releaseDate', 'Release date (YYYY-MM-DD)', { placeholder: '2024-05-31' });
  const tags = [h('label', {}, 'Custom tags (comma separated)'), h('input', { value: t.tags.join(', ') })], desc = [h('label', {}, 'Description'), h('textarea', { rows: 3, maxlength: 2000 }, t.description || '')], art = artPicker(), err = h('p', { class: 'err', role: 'alert' });
  const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean), n = (el) => (el.value === '' ? null : Number(el.value));
  const d = dialog('Edit song', ...title, ...artists, h('div', { class: 'field-row' }, h('div', {}, ...album), h('div', {}, ...aa)), h('div', { class: 'field-row' }, h('div', {}, ...genre), h('div', {}, ...yr)), h('div', { class: 'field-row' }, h('div', {}, ...tn), h('div', {}, ...dn)), ...rd, ...tags, ...desc,
    h('label', {}, 'Replace cover art'), art, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try {
      await api('PATCH', `/tracks/${t.id}`, { title: title[1].value, artists: csv(artists[1].value), album: album[1].value, albumArtist: aa[1].value, genre: genre[1].value, trackNo: n(tn[1]), discNo: n(dn[1]), year: n(yr[1]), releaseDate: rd[1].value || null, tags: csv(tags[1].value), description: desc[1].value });
      if (art.files[0]) await putArt('track', t.id, art.files[0]); d.close(); await loadLibrary(); toast('Saved'); route(); } catch (x) { err.textContent = x.message; e.currentTarget.disabled = false; } } }, 'Save'),
      t.artKey ? h('button', { class: 'btn ghost', onclick: async () => { try { await api('PATCH', `/tracks/${t.id}`, { removeArt: true }); d.close(); await loadLibrary(); route(); } catch (x) { err.textContent = x.message; } } }, 'Remove art') : null, closer()));
}
function editProfile(kind, id, name, prof) {
  const desc = h('textarea', { rows: 4, maxlength: 2000 }, prof?.description || ''), art = artPicker(), err = h('p', { class: 'err', role: 'alert' }), title = kind === 'album' ? h('input', { value: name }) : null;
  const d = dialog(`Edit ${kind}`, title ? [h('label', {}, 'Album title (renames it on all its songs)'), title] : null, h('label', {}, 'Description'), desc, h('label', {}, 'Cover picture'), art, err, h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { try {
    if (title && title.value.trim() && title.value.trim() !== name) await api('POST', `/albums/${id}/rename`, { title: title.value.trim() });
    await api('PATCH', `/${kind}s/${id}`, { description: desc.value }); if (art.files[0]) await putArt(kind, id, art.files[0]); d.close(); await loadLibrary(); toast('Saved'); if (title && title.value.trim() !== name) location.hash = '#/library'; else route(); } catch (x) { err.textContent = x.message; } } }, 'Save'), closer()));
}

// ---------------- upload ----------------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (blob) => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
async function uploadFile(file, setStatus, setProgress) {
  if (!crypto.subtle) throw new Error('Uploads need a secure (https) connection.');
  setStatus('Reading tags…'); const [tags, dur] = await Promise.all([readTags(file), audioDuration(file)]); const guess = guessFromName(file.name);
  if (dur === null) setStatus('Note: this browser cannot decode this file, so it may not play here.');
  const P = S.meta.partSize, n = Math.ceil(file.size / P), hashes = [];
  setStatus('Checking for duplicates…'); for (let i = 0; i < n; i++) hashes.push(await sha(file.slice(i * P, (i + 1) * P)));
  const fingerprint = await sha(new Blob([hashes.join('')]));
  const start = await api('POST', '/uploads/start', { name: file.name, size: file.size, fingerprint });
  if (start.duplicate) return { duplicate: start.duplicate.title };
  const parts = [];
  for (let i = 0; i < n; i++) {
    setStatus(`Uploading ${i + 1} of ${n}…`); const chunk = file.slice(i * P, (i + 1) * P); let last;
    for (let a = 0; a < 3; a++) { try { parts.push(await sendBytes(`/uploads/${start.uploadId}/parts/${i}`, chunk, { 'X-Chunk-Sha256': hashes[i] })); last = null; break; } catch (e) { last = e; if (e.status && e.status < 500 && e.code !== 'checksum_mismatch') break; await new Promise((r) => setTimeout(r, 800 * (a + 1))); } }
    if (last) throw last; setProgress((i + 1) / n);
  }
  let art = null; if (tags.picture) { const b = await shrinkImage(new Blob([tags.picture.data], { type: tags.picture.mime })); if (b && b.size < 2 * 1024 * 1024) { try { art = await sendBytes(`/uploads/${start.uploadId}/art`, b); } catch { /* the song still uploads without art */ } } }
  setStatus('Saving…');
  const meta = { title: tags.title || guess.title, artists: tags.artists.length ? tags.artists : [guess.artist || 'Unknown artist'], album: tags.album || 'Unknown album', albumArtist: tags.albumArtist || '', trackNo: tags.trackNo, discNo: tags.discNo, year: tags.year, genre: tags.genre, durationMs: dur || 0 };
  return api('POST', `/uploads/${start.uploadId}/finish`, { name: file.name, size: file.size, parts, meta, ...(art ? { art } : {}) });
}
function uploadView() {
  const list = h('div', {}), input = h('input', { type: 'file', multiple: '', accept: 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav', 'aria-label': 'Choose audio files', style: 'display:none' });
  const run = async () => {
    const files = [...input.files]; input.value = ''; let ok = 0;
    for (const file of files) {
      const st = h('div', { class: 'st' }, 'Waiting…'), bar = h('i'), row = h('div', { class: 'upitem' }, h('div', { class: 'ttl' }, file.name), st, h('div', { class: 'prog' }, bar)); list.append(row);
      const say = (m, cls = '') => { st.textContent = m; st.className = `st ${cls}`; };
      try { const r = await uploadFile(file, say, (p) => { bar.style.width = `${Math.round(p * 100)}%`; }); if (r.duplicate) say(`Already in your library as "${r.duplicate}". Skipped.`); else { ok++; bar.style.width = '100%'; say('Added', 'ok'); } }
      catch (e) { say(e.message || 'Upload failed', 'bad'); }
    }
    if (ok) { await loadLibrary(); toast(`${ok} song${ok > 1 ? 's' : ''} added`); }
  };
  input.onchange = run;
  frame('upload', topbar('Add music'), h('div', { class: 'upl' }, icon('upload', 36), h('p', {}, 'Add songs you own: MP3, M4A/AAC, FLAC, OGG or WAV.'), h('button', { class: 'btn', onclick: () => input.click() }, 'Choose files'), input,
    h('p', { class: 'fine muted' }, `Up to ${S.meta.maxFileMb} MB per song. Files go to your private storage in small pieces, so big files and flaky connections are fine. Tags and cover art are read from the file; you can edit them afterwards.`)), list,
    h('p', { class: 'fine muted' }, `Storage used: ${fmtSize(S.used || 0)} of ${S.meta.libraryLimitMb} MB.`));
}

// ---------------- stats ----------------
async function statsView() {
  let range = S.statRange || 'month'; const tz = -new Date().getTimezoneOffset(); const body = h('div', {});
  const load = async (from, to) => { body.replaceChildren(h('p', { class: 'muted' }, 'Loading…')); try { const q = range === 'custom' ? `&from=${from}&to=${to}` : ''; draw(await api('GET', `/stats?range=${range}&tz=${tz}&limit=10${q}`)); } catch (x) { body.replaceChildren(h('p', { class: 'err' }, x.message)); } };
  const draw = (s) => {
    const max = Math.max(1, ...s.byDay.map((d) => d.listenMs)); const nod = s.byDay.filter((d) => d.noData).length;
    body.replaceChildren(
      !s.coverage.hasAnyData ? h('div', { class: 'empty' }, 'No listening recorded yet. Play some music and check back.') : h('div', {},
        h('div', { class: 'stat-grid' }, [['Plays', s.totals.plays], ['Listening', fmtHours(s.totals.listenMs)], ['Skips', s.totals.skips], ['Songs', s.totals.uniqueTracks]].map(([l, v]) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l)))),
        h('h2', { class: 'sec' }, 'Listening by day'), h('div', { class: 'bars', role: 'img', 'aria-label': 'Listening time per day' }, s.byDay.map((d) => h('i', { class: d.noData ? 'nod' : '', style: d.noData ? '' : `height:${Math.max(2, Math.round((d.listenMs / max) * 100))}%`, title: d.noData ? `${d.date}: no data` : `${d.date}: ${d.plays} plays, ${fmtHours(d.listenMs)}` }))),
        nod ? h('p', { class: 'fine muted' }, `Hatched bars have no data: listening was not tracked before ${new Date(s.coverage.trackingSince).toLocaleDateString()}. That is different from zero plays.`) : h('p', { class: 'fine muted' }, `Tracking since ${new Date(s.coverage.trackingSince).toLocaleDateString()}.`),
        h('h2', { class: 'sec' }, 'Top songs'), h('div', { class: 'rows' }, s.topTracks.map((x, i) => { const t = S.byId.get(x.trackId); return t ? trackRow(t, s.topTracks.map((y) => S.byId.get(y.trackId)).filter(Boolean), i, { extra: h('span', { class: 'dur' }, `${x.plays}×`) }) : null; })),
        h('h2', { class: 'sec' }, 'Top artists'), h('div', { class: 'rows' }, s.topArtists.map((a, i) => h('div', { class: 'row-t' }, h('span', { class: 'dur' }, i + 1), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, a.name), h('div', { class: 'sub2' }, fmtHours(a.listenMs))), h('span', { class: 'dur' }, `${a.plays} plays`)))),
        s.topGenres.length ? h('div', {}, h('h2', { class: 'sec' }, 'Top genres'), s.topGenres.map((g) => h('span', { class: 'chip', style: 'margin:0 .3rem .3rem 0;display:inline-block' }, `${g.name} · ${g.plays}`))) : null));
  };
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' }), custom = h('div', { class: 'searchbar', hidden: range === 'custom' ? null : '' }, from, to, h('button', { class: 'btn', onclick: () => from.value && to.value && load(from.value, to.value) }, 'Show'));
  const chip = (r, l) => h('button', { class: 'chip', 'aria-pressed': range === r ? 'true' : 'false', onclick: (e) => { range = S.statRange = r; document.querySelectorAll('.chips .chip').forEach((c) => c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false')); custom.hidden = r !== 'custom'; if (r !== 'custom') load(); } }, l);
  frame('stats', topbar('Your listening'), h('div', { class: 'chips' }, chip('week', 'Week'), chip('month', 'Month'), chip('year', 'Year'), chip('custom', 'Custom')), custom, body, h('p', { class: 'fine muted' }, 'A play counts after 30 seconds of real listening (or half of a short track). Starts under 3 seconds are ignored.'));
  load();
}

// ---------------- more / settings ----------------
async function moreMenu() {
  const u = await offline.usage().catch(() => ({ bytes: 0 }));
  const d = dialog('Jupiter', h('p', { class: 'sub' }, `Signed in as ${S.me.user.displayName}. Music storage: ${S.meta.storage === 'github' ? 'private GitHub branch' : 'local files'}. ${S.tracks.length} songs, ${fmtSize(S.used || 0)} of ${S.meta.libraryLimitMb} MB. On this device: ${fmtSize(u.bytes)} downloaded.`), h('div', { class: 'menu' },
    canPromptInstall() && !isStandalone() ? mi('download', 'Install Jupiter', promptInstall) : null,
    mi('file', 'Export library list (no audio)', async () => { const j = await api('GET', '/export'); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' })), download: 'jupiter-library.json' }); a.click(); }),
    S.meta.can.maintain ? mi('settings', 'Storage upkeep…', maintenance) : null, mi('home', 'Universe dashboard', () => { location.href = '/dashboard/'; }),
    mi('logout', 'Sign out', async () => { try { await rootApi('POST', '/api/auth/logout'); } catch { /* already out */ } S.me = null; boot(); })), closer());
  function mi(ic, text, fn) { return h('button', { onclick: () => { d.close(); fn(); } }, icon(ic), text); }
}
async function maintenance() {
  const st = await api('GET', '/maintenance/status'), msg = h('p', { class: 'fine muted' }, `Branch: ${st.branch || 'n/a'}. History is squashed weekly (${st.cronConfigured ? 'cron secret set' : 'CRON_SECRET not set: weekly job inactive'}). Old commits may stay reachable on GitHub until it cleans them up.`);
  const d = dialog('Storage upkeep', msg, h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: async () => { try { const r = await api('GET', '/maintenance/orphans'); msg.textContent = `${r.files} files; ${r.orphanCount} unreferenced; ${r.missingCount} referenced but missing. Report only; nothing deleted.`; } catch (x) { toast(x.message); } } }, 'Check files'),
    h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Squash the music branch history now? All songs and artwork are kept.')) return; try { const r = await api('POST', '/maintenance/rebuild-history?confirm=true'); toast(r.skipped || 'History rebuilt'); } catch (x) { toast(x.message); } } }, 'Rebuild history now'), closer()));
}

// ---------------- mini player and Now Playing ----------------
let mini, np, npParts = {};
function drawMini() {
  mini?.remove(); mini = null; const t = pl.current(); if (!t) return;
  const bar = h('div', { class: 'bar' }), title = h('div', { class: 'ttl' }, t.title), sub = h('div', { class: 'sub2' }, t.artists.join(', ')), play = h('button', { class: 'iconbtn', 'aria-label': 'Play or pause', onclick: (e) => { e.stopPropagation(); pl.toggle(); } });
  mini = h('div', { class: 'mini', role: 'group', 'aria-label': 'Player', onclick: openNow }, artEl(artKeyOf(t)), h('div', { class: 'meta' }, title, sub), play, h('button', { class: 'iconbtn', 'aria-label': 'Next', onclick: (e) => { e.stopPropagation(); pl.next(); } }, icon('next')), bar);
  mini._upd = () => { const s = pl.state(); play.replaceChildren(icon(s.playing ? 'pause' : 'play')); bar.style.width = s.dur ? `${(s.pos / s.dur) * 100}%` : '0'; }; mini._upd(); document.body.append(mini);
}
function drawNow() { if (np) openNow(true); }
function openNow(redraw) {
  const t = pl.current(); if (!t) return; if (np && redraw !== true) return; np?.remove();
  const seek = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, 'aria-label': 'Seek', oninput: (e) => { const s = pl.state(); if (s.dur) pl.seek((e.target.value / 1000) * s.dur); } }), cur = h('span', {}, '0:00'), tot = h('span', {}, fmtTime(t.durationMs));
  const playBtn = h('button', { class: 'iconbtn play', 'aria-label': 'Play or pause', onclick: pl.toggle }), shuf = h('button', { class: 'iconbtn', 'aria-label': 'Shuffle', onclick: () => pl.setShuffle(!pl.P.shuffle) }, icon('shuffle')), rep = h('button', { class: 'iconbtn', 'aria-label': 'Repeat', onclick: pl.cycleRepeat }, icon('repeat'));
  const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round(pl.P.volume * 100), 'aria-label': 'Volume', oninput: (e) => pl.setVolume(e.target.value / 100) });
  const queue = h('div', { class: 'rows queue' });
  const drawQueue = () => queue.replaceChildren(h('h2', { class: 'sec' }, 'Up next'), pl.P.queue.map((id, i) => { const q = S.byId.get(id) || pl.P.tracks.get(id); if (!q) return null; return h('div', { class: `row-t ${i === pl.P.index ? 'now' : ''}`, onclick: () => pl.jump(i) }, artEl(artKeyOf(q)), h('div', { class: 'meta' }, h('div', { class: 'ttl' }, q.title), h('div', { class: 'sub2' }, q.artists.join(', '))),
    i !== pl.P.index ? h('span', { style: 'display:flex' }, h('button', { class: 'iconbtn', 'aria-label': 'Move up', onclick: (e) => { e.stopPropagation(); pl.moveInQueue(i, -1); } }, icon('up')), h('button', { class: 'iconbtn', 'aria-label': 'Move down', onclick: (e) => { e.stopPropagation(); pl.moveInQueue(i, 1); } }, icon('down')), h('button', { class: 'iconbtn', 'aria-label': 'Remove from queue', onclick: (e) => { e.stopPropagation(); pl.removeFromQueue(i); } }, icon('x'))) : null); }));
  np = h('div', { class: 'np', role: 'dialog', 'aria-label': 'Now playing' }, h('div', { class: 'head' }, h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: closeNow }, icon('chevdown')), h('b', {}, 'Now playing'), h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: () => trackMenu(t) }, icon('more'))),
    h('div', { class: 'cover' }, artEl(artKeyOf(t), { cls: 'big' })), h('div', { class: 'side-col' }, h('div', { style: 'display:flex;align-items:center;gap:.5rem' }, h('div', { style: 'flex:1;min-width:0' }, h('h2', {}, t.title), h('div', { class: 'artist' }, t.artists.join(', '), ' · ', t.album)), h('button', { class: `iconbtn ${t.liked ? 'on' : ''}`, 'aria-label': 'Like', onclick: () => toggleLike(t) }, icon('heart'))),
      seek, h('div', { class: 'times' }, cur, tot), h('div', { class: 'ctl' }, shuf, h('button', { class: 'iconbtn', 'aria-label': 'Previous', onclick: () => pl.prev() }, icon('prev')), playBtn, h('button', { class: 'iconbtn', 'aria-label': 'Next', onclick: () => pl.next() }, icon('next')), rep),
      h('div', { class: 'vol' }, icon('vol'), vol), queue));
  np._upd = () => { const s = pl.state(); playBtn.replaceChildren(icon(s.playing ? 'pause' : 'play')); if (s.dur && document.activeElement !== seek) seek.value = Math.round((s.pos / s.dur) * 1000); cur.textContent = fmtTime(s.pos * 1000); if (s.dur) tot.textContent = fmtTime(s.dur * 1000);
    shuf.classList.toggle('on', pl.P.shuffle); rep.classList.toggle('on', pl.P.repeat !== 'off'); rep.title = `Repeat: ${pl.P.repeat}`; }; np._upd(); drawQueue(); np._q = drawQueue; document.body.append(np);
}
function closeNow() { np?.remove(); np = null; }
let lastTrack = null;
pl.on(() => { mini?._upd?.(); np?._upd?.(); const c = pl.current()?.id; if (c !== lastTrack) { lastTrack = c; if (np) openNow(true); drawMini(); if (!c) root.className = 'has-no-mini'; else root.className = ''; document.title = pl.current() ? `${pl.current().title} · Jupiter` : 'Jupiter'; } else np?._q?.(); });

// ---------------- Nebula ----------------
let neb = null;
function openNebula() {
  if (neb) return; const log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite' }), input = h('textarea', { rows: 1, enterkeyhint: 'send', placeholder: 'Ask Nebula to play something…', 'aria-label': 'Message Nebula' }), send = h('button', { class: 'btn', 'aria-label': 'Send' }, icon('send'));
  const add = (cls, ...k) => { const m = h('div', { class: `msg ${cls}` }, ...k); log.append(m); log.scrollTop = log.scrollHeight; return m; };
  const submit = async (text) => {
    text = (text ?? input.value).trim(); if (!text) return; input.value = ''; add('user', text); const wait = add('assistant', '…'); send.disabled = true;
    try { const r = await rootApi('POST', '/api/ai/chat', { message: text, ...(S.conv ? { conversationId: S.conv } : {}), clientContext: pl.snapshot() }); S.conv = r.conversation.id; wait.replaceChildren(renderMarkdown(r.reply.content, h)); for (const a of r.actions || []) if (a.app === 'jupiter') await runAction(a, log); }
    catch (x) { wait.replaceChildren(x.message); } finally { send.disabled = false; log.scrollTop = log.scrollHeight; }
  };
  send.onclick = () => submit(); input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  const sugg = ['Play my favourite songs', 'What have I been listening to lately?', 'Make a playlist for late-night studying', 'Play my most listened songs this month'];
  neb = h('div', { class: 'neb', role: 'dialog', 'aria-label': 'Nebula' }, h('div', { style: 'display:flex;align-items:center;gap:.5rem' }, icon('sparkle'), h('b', { style: 'flex:1' }, 'Nebula · Jupiter'), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => { neb.remove(); neb = null; } }, icon('x'))),
    log, h('div', { class: 'sugg' }, sugg.map((s) => h('button', { class: 'chip', onclick: () => submit(s) }, s))), h('div', { class: 'in' }, input, send));
  document.body.append(neb); add('assistant', 'Tell me what to play, or ask about your listening. I only use songs that are really in your library.'); input.focus();
}
// The browser only runs these fixed action types, and only for tracks that exist in the library it just loaded.
async function runAction(a, log) {
  if (a.type === 'play') {
    const tracks = songs(a.trackIds || []); if (!tracks.length) { toast('Those songs are not in your library.'); return; }
    if (a.mode === 'next' || a.mode === 'append') { pl.enqueue(tracks, a.mode === 'next' ? 'next' : 'append'); toast(`Queued ${tracks.length}`); }
    else { pl.playList(tracks, 0, { src: 'nebula', shuffle: !!a.shuffle }); toast(`Playing ${a.label || 'your music'}`); }
  } else if (a.type === 'control') {
    const m = { pause: () => pl.pause(), resume: () => pl.resume(), next: () => pl.next(), previous: () => pl.prev(), shuffleOn: () => pl.setShuffle(true), shuffleOff: () => pl.setShuffle(false), repeatOff: () => pl.setRepeat('off'), repeatOne: () => pl.setRepeat('one'), repeatAll: () => pl.setRepeat('all'),
      seek: () => pl.seek(Number(a.value)), volume: () => pl.setVolume(Number(a.value) / 100), like: () => pl.current() && !pl.current().liked && toggleLike(pl.current()), unlike: () => pl.current()?.liked && toggleLike(pl.current()) };
    m[a.action]?.();
  } else if (a.type === 'refresh') { await loadLibrary(); route(); } else if (a.type === 'openPlaylist') { await loadLibrary(); } else if (a.type === 'confirm') {
    const box = h('div', { class: 'msg assistant confirm' }, h('p', {}, a.action === 'deleteTrack' ? `Delete "${a.title}" by ${a.artist} permanently?` : a.action === 'deletePlaylist' ? `Delete the playlist "${a.title}"? Its songs stay in your library.` : `Clear all songs from "${a.title}"? The songs stay in your library.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async (e) => { e.currentTarget.disabled = true; try {
        if (a.action === 'deleteTrack') { await api('DELETE', `/tracks/${a.trackId}?confirm=true`); await offline.remove(a.trackId).catch(() => {}); } else if (a.action === 'deletePlaylist') await api('DELETE', `/playlists/${a.playlistId}?confirm=true`); else await api('PUT', `/playlists/${a.playlistId}/tracks`, { trackIds: [] });
        await loadLibrary(); await refreshOffline(); box.replaceChildren('Done.'); route(); } catch (x) { box.replaceChildren(x.message); } } }, 'Yes, do it'), h('button', { class: 'btn ghost', onclick: () => box.replaceChildren('Cancelled. Nothing was changed.') }, 'Cancel'))); log.append(box);
  }
}

// ---------------- routing and boot ----------------
async function route() {
  if (!S.me && !S.offlineMode) return; const [, page = '', arg] = (location.hash || '#/').split('/');
  try {
    if (S.offlineMode) return await downloadsView();
    if (page === 'library') libraryView(); else if (page === 'album') albumView(arg); else if (page === 'artist') artistView(arg); else if (page === 'playlist') playlistView(arg);
    else if (page === 'upload') uploadView(); else if (page === 'downloads') await downloadsView(); else if (page === 'stats') await statsView(); else homeView();
  } catch (x) { if (x.status === 401) return; frame('home', topbar('Jupiter'), h('p', { class: 'err', role: 'alert' }, `Something went wrong: ${x.message}`), h('button', { class: 'btn ghost', onclick: route }, 'Try again')); }
}
async function boot(note = '') {
  try { S.me = await rootApi('GET', '/api/auth/me'); }
  catch (e) {
    if (!e.status) { // no connection at all: offline mode with downloaded tracks only
      S.offlineMode = true; S.meta = { can: {}, partSize: 0 }; S.me = null; await refreshOffline(); const metas = (await offline.list()).filter((m) => m.done); for (const m of metas) { S.byId.set(m.id, m.track); pl.P.tracks.set(m.id, m.track); } S.tracks = metas.map((m) => m.track);
      S.me = { user: { displayName: 'you' } }; return route();
    }
    S.me = await showAuth({ root, brand, note });
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
