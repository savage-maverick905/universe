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
  // Online: always the newest files (so a deploy never mixes old and new code). No answer within 4 seconds, or offline:
  // the copy kept on the device, so the app still opens with its screens and navigation. A page that was never stored
  // falls back to the app's own start page. Only this app's own cache is ever read.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const stored = () => cache.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? cache.match(shell[0]) : undefined));
    try {
      const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 4000))]);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await stored().catch(() => undefined);
      if (hit) return hit;
      throw err; // nothing stored: let the browser show its normal error
    }
  })());
});

// Tapping a notification opens (or focuses) the app page it points to.
self.addEventListener('notificationclick', (e) => {
  e.notification.close(); const url = e.notification.data?.url || '/dashboard/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => { const hit = list.find((c) => new URL(c.url).pathname === new URL(url, self.location.origin).pathname); if (hit) { hit.navigate?.(url); return hit.focus(); } return self.clients.openWindow(url); }));
});
