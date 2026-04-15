const CACHE = 'theoreum-attendance-shell-v18';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/theoreum-banner.png',
  '/student-qr-brand.svg',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-apple-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    const results = await Promise.allSettled(
      SHELL.map(async (url) => {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res || !res.ok || res.type === 'opaque') {
          throw new Error('CACHE_INSTALL_FAIL: ' + url + ' [' + (res ? res.status : 'NO_RESPONSE') + ']');
        }
        await cache.put(url, res.clone());
      })
    );

    const failed = results
      .filter(x => x.status === 'rejected')
      .map(x => String(x.reason && x.reason.message ? x.reason.message : x.reason || 'unknown'));

    if (failed.length) {
      console.warn('[SW_INSTALL_PARTIAL_FAIL]', failed);
    }

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((k) => (k !== CACHE ? caches.delete(k) : Promise.resolve()))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((res) => {
          if (!res || !res.ok || res.type === 'opaque') return res;
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request));
    })
  );
});