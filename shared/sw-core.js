// Service-worker logic shared by every Universe app. Each app has a tiny sw.js that sets
// self.UNIVERSE_SW = { prefix, version, shell: [urls] } and then importScripts('/shared/sw-core.js').
//
// What it does: keeps the app's own files so it opens instantly and shows its screens offline ("You're offline" appears only where data is needed).
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
  // The app's own files are answered from the device first, so it opens instantly and works with no connection. In the
  // background the newest copy is fetched and kept for next time (each deploy also bumps the version in sw.js, which
  // replaces the whole set at once). If a file is not stored yet it comes from the network, and a page that cannot be
  // loaded at all falls back to the app's own start page, so the screens and navigation are still there.
  const cached = async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await caches.match(shell[0]) : null);
  const refresh = fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; });
  event.respondWith((async () => {
    const hit = await cached();
    if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
    try { return await refresh; }
    catch { return new Response("You're offline.", { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
  })());
});

// Tapping a notification opens (or focuses) the app page it points to.
self.addEventListener('notificationclick', (e) => {
  e.notification.close(); const url = e.notification.data?.url || '/dashboard/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => { const hit = list.find((c) => new URL(c.url).pathname === new URL(url, self.location.origin).pathname); if (hit) { hit.navigate?.(url); return hit.focus(); } return self.clients.openWindow(url); }));
});
