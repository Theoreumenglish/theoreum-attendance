const VERSION = 'student-qr-vercel-v18';
const CACHE_NAME = 'theoreum-student-qr-' + VERSION;

const SHELL_URLS = [
  '/student-qr.html',
  '/student-qr-manifest.webmanifest',
  '/student-qr-lib.js',
  '/theoreum-banner.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-apple-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    const results = await Promise.allSettled(
      SHELL_URLS.map(async (url) => {
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
      console.warn('[STUDENT_QR_SW_INSTALL_PARTIAL_FAIL]', failed);
    }

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
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
      fetch(event.request).catch(() => caches.match('/student-qr.html'))
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
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request));
    })
  );
});