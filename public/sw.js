const CACHE_NAME = "cinefil-v9-voice-validation";
const BASE_URL = new URL(self.registration.scope);
const APP_SHELL = new URL("index.html", BASE_URL).href;
const CORE = [
  "",
  "index.html",
  "manifest.webmanifest",
  "favicon.ico",
  "src/styles.css",
  "src/main.js",
  "src/game/achievements.js",
  "src/game/catalog.js",
  "src/game/database.js",
  "src/game/diagnostics.js",
  "src/game/engine.js",
  "src/game/identity.js",
  "src/game/storage.js",
  "src/game/static-overlay.js",
  "src/game/transfer.js",
  "src/voice/entity-resolver.js",
  "src/voice/phonetics.js",
  "src/voice/speech-session.js",
  "src/voice/turn-buffer.js",
  "src/data/cinema-knowledge.json",
  "src/data/cinema-synonyms.json",
  "assets/inter-latin-400-normal-C38fXH4l.woff2",
  "assets/inter-latin-600-normal-LgqL8muc.woff2",
  "assets/playfair-display-latin-700-normal-CuDiGg7c.woff2",
  "assets/tmdb-logo.svg",
  "__l5e/assets-v1/5ff43c75-eae3-43ba-80e0-f5b47be859df/cinema-seats.png",
  "__l5e/assets-v1/8a9f592b-23da-4698-8a14-e0016a7b6c74/cinefil-logo.png"
].map((path) => new URL(path, BASE_URL).href);
const OPTIONAL = [
  "src/data/tmdb-overlay-index.json",
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(async (cache) => {
      await cache.addAll(CORE);
      await Promise.allSettled(OPTIONAL.map((url) => cache.add(url)));
    })
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("cinefil-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const apiPath = new URL("api/", BASE_URL).pathname;
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith(apiPath)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL, copy));
      return response;
    }).catch(() => caches.match(APP_SHELL)));
    return;
  }
  const runtimeSource = /\/src\/.*\.(?:js|css)$/.test(url.pathname);
  if (runtimeSource) {
    event.respondWith(fetch(request, { cache: "no-cache" }).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
