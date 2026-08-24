/* Minimal service worker: exists mainly so the browser considers the page
   installable, and so the installed PWA gets a useful "vno isn't running"
   page instead of the browser's bare connection-refused error when its
   fixed start_url can't be reached. No caching strategy beyond that single
   fallback page - every other asset here is meant to be read fresh (see
   server/assets.ts), and there is nothing useful to do offline.

   This file runs in a ServiceWorkerGlobalScope, not the DOM, so it's its own
   TypeScript project (tsconfig.sw.json) - the browser modules under js/ need
   DOM globals this scope doesn't have, and vice versa. */

/** The lib's `self` is a plain WorkerGlobalScope; this is the real thing. */
const sw = self as unknown as ServiceWorkerGlobalScope;

const OFFLINE_URL = "/assets/offline.html";
// Bump this whenever offline.html changes. A fixed cache name alone doesn't
// refresh anything - the browser only re-runs "install" (and re-fetches
// OFFLINE_URL into the cache) when this file's own bytes change, so without
// a version bump an edited offline.html would keep serving the stale cached
// copy indefinitely.
const CACHE_NAME = "vno-shell-v2";

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
  );
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener("fetch", (event) => {
  // Only step in for the top-level page load; every other request (API
  // calls, media, assets) should fail normally so the app's own "can't
  // reach the server" handling applies instead of a stale cached response.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      // A cache miss here would previously hand `undefined` to respondWith and
      // surface as an opaque TypeError; a network-error Response is what the
      // browser would have shown anyway without this worker.
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error())
    )
  );
});
