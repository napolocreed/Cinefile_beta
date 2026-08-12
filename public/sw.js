const CACHE_NAME = "cinefil-v4-snapshot-175f860";
const CORE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/src/styles.css",
  "/src/main.js",
  "/src/game/achievements.js",
  "/src/game/catalog.js",
  "/src/game/database.js",
  "/src/game/diagnostics.js",
  "/src/game/engine.js",
  "/src/game/identity.js",
  "/src/game/storage.js",
  "/src/game/transfer.js",
  "/src/voice/entity-resolver.js",
  "/src/voice/speech-session.js",
  "/src/data/cinema-knowledge.json",
  "/src/data/cinema-synonyms.json",
  "/assets/inter-latin-400-normal-C38fXH4l.woff2",
  "/assets/inter-latin-600-normal-LgqL8muc.woff2",
  "/assets/playfair-display-latin-700-normal-CuDiGg7c.woff2",
  "/__l5e/assets-v1/5ff43c75-eae3-43ba-80e0-f5b47be859df/cinema-seats.png",
  "/__l5e/assets-v1/8a9f592b-23da-4698-8a14-e0016a7b6c74/cinefil-logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("cinefil-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
      return response;
    }).catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
