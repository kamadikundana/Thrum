// Minimal offline cache for the PWA shell. Network-first: always tries to
// fetch the latest file first (so updates show up immediately without a
// cache-busting dance), and only falls back to a cached copy when the
// network is unavailable — e.g. the app was already open and the
// connection drops, or it's reopened offline after a first successful load.

const CACHE_NAME = "cardiobaseline-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only cache same-origin GET requests — never camera streams or
  // cross-origin calls.
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
