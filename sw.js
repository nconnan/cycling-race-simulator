// Offline support: cache the app shell, serve it cache-first, refresh in the background.
// Bump VERSION whenever any file below changes so installed apps pick up the update.
const VERSION = 'race-sim-v11.7.1';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/core.js',
  'js/history-data.js',
  'js/app/state.js',
  'js/app/race.js',
  'js/app/track.js',
  'js/app/tables.js',
  'js/app/planning.js',
  'js/app/library.js',
  'js/app/course-map.js',
  'js/app/review.js',
  'js/app/ux.js',
  'js/app/startup.js',
  'manifest.webmanifest',
  'fonts/inter-latin.woff2',
  'fonts/jetbrains-mono-latin.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
