// Axon PWA service worker — offline app shell, network-first for same-origin.
const CACHE = 'axon-v1';
const SHELL = ['./app.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // never touch cross-origin (Particle Cloud / your API / fonts) or event streams
  if (url.origin !== self.location.origin) return;
  if (req.headers.get('accept') && req.headers.get('accept').includes('text/event-stream')) return;
  // network-first, fall back to cache (so the app opens offline)
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./app.html')))
  );
});
