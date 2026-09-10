// PWA app-shell cache — makes the shell (this HTML/CSS/JS) load instantly
// and work offline, showing whatever data the vault already has locally.
// Deliberately does NOT touch anything under /api/ — those are live
// financial/market data from the relay (see server.js) and must always hit
// the network, never a stale cache. Bump CACHE_NAME on every shell release
// so returning visitors pick up the new files instead of stale cached ones.
const CACHE_NAME = 'tradone-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './storage.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only ever cache same-origin GETs — this also naturally excludes the
  // relay, which lives on a different origin/port (see app.js's API_BASE),
  // and excludes /api/* even in a deployment where it happened to share an
  // origin with the shell.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache a real, successful, same-origin response — never an
        // opaque/error response, which would otherwise poison the cache
        // with something unusable offline.
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      });
    })
  );
});
