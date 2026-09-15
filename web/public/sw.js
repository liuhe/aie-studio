// Minimal service worker — installable PWA, no caching.
// Chrome's installability check requires a registered SW with a fetch
// handler; the handler doesn't need to do anything beyond exist. We deliberately
// don't cache: every asset (HTML/JS/CSS) and every API/WS call is server-backed,
// and stale cached HTML pointing at an old JS bundle would break worse than a
// network error would.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentional pass-through.
});
