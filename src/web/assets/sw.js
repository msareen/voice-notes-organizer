/* Minimal service worker: exists mainly so the browser considers the page
   installable, and so the installed PWA gets a useful "vno isn't running"
   page instead of the browser's bare connection-refused error when its
   fixed start_url can't be reached. No caching strategy beyond that single
   fallback page - every other asset here is meant to be read fresh (see
   server/assets.js), and there is nothing useful to do offline. */
const OFFLINE_URL = "/assets/offline.html";
// Bump this whenever offline.html changes. A fixed cache name alone doesn't
// refresh anything - the browser only re-runs "install" (and re-fetches
// OFFLINE_URL into the cache) when this file's own bytes change, so without
// a version bump an edited offline.html would keep serving the stale cached
// copy indefinitely.
const CACHE_NAME = "vno-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Only step in for the top-level page load; every other request (API
  // calls, media, assets) should fail normally so the app's own "can't
  // reach the server" handling applies instead of a stale cached response.
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
