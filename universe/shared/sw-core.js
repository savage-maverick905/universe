// Service-worker logic shared by every Universe app. Each app has a tiny sw.js that sets
// self.UNIVERSE_SW = { prefix, version, shell: [urls] } and then importScripts('/shared/sw-core.js').
//
// What it does: keeps the app's own files so it opens instantly and shows its shell offline.
// What it never does: cache /api/ (your data is always live) or touch other websites.
const { prefix, version, shell } = self.UNIVERSE_SW;
const CACHE = `${prefix}-${version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(shell.map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(`${prefix}-`) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Network first, so updates show up as soon as you are online; the cache is the offline fallback.
  event.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const page = await caches.match(shell[0]); if (page) return page; }
    return new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
