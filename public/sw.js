/* VELA network-first worker. Never freeze HTML. */
const BUILD = "20260820b";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    fetch(req, { cache: "no-store" }).catch(() => caches.match(req)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "vela-skip") self.skipWaiting();
});
