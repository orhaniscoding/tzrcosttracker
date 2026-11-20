/* CostCore service worker: network-only compatibility worker.
 * It intentionally registers NO fetch handler, so it never intercepts or
 * answers requests from a cache. Its only job is to let an already installed
 * legacy worker upgrade itself and to drop only legacy versioned caches named costcore-v<digits>.
 * Every request uses the browser default network path; there is no offline
 * guarantee and no page or asset caching of any kind.
 */

const LEGACY_CACHE_PATTERN = /^costcore-v\d+$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const cleanup = caches
    .keys()
    .then((keys) => {
      const legacyKeys = keys.filter((key) => LEGACY_CACHE_PATTERN.test(key));
      return Promise.all(legacyKeys.map((key) => caches.delete(key)));
    })
    .then(() => self.clients.claim());

  event.waitUntil(cleanup);
});
