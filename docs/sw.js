/* Offline shell. Bump CACHE when you change app files. */
const CACHE = 'swing-v9';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './assets/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* network-first so edits show up immediately, cache as offline fallback */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  /* video is streamed as byte-range requests — caching those 206
     partial-content responses would just overwrite each other under
     the same URL key, and could serve a truncated clip if one ever
     got replayed while offline. Let those go straight to the network. */
  if (e.request.headers.has('range')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
