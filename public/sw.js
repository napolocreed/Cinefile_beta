const CACHE_NAME = "cinefil-v14-tableau-d-honneur";
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
  "src/game/credits.js",
  "src/game/database.js",
  "src/game/diagnostics.js",
  "src/game/engine.js",
  "src/game/identity.js",
  "src/game/statistics.js",
  "src/game/storage.js",
  "src/game/transfer.js",
  "src/ui/format.js",
  "src/ui/link-check.js",
  "src/ui/router.js",
  "src/ui/runtime.js",
  "src/ui/shell.js",
  "src/ui/verification.js",
  "src/ui/voice-state.js",
  "src/ui/screens/credits.js",
  "src/ui/screens/home.js",
  "src/ui/screens/play.js",
  "src/ui/screens/profiles.js",
  "src/ui/screens/results.js",
  "src/ui/screens/setup.js",
  "src/ui/screens/voice.js",
  "src/voice/entity-resolver.js",
  "src/voice/phonetics.js",
  "src/voice/speech-session.js",
  "src/voice/turn-buffer.js",
  "src/data/cinema-knowledge.json",
  "src/data/cinema-synonyms.json",
  "assets/inter-latin-400-normal-C38fXH4l.woff2",
  "assets/inter-latin-600-normal-LgqL8muc.woff2",
  "assets/oswald-latin-700-normal.woff2",
  "assets/oswald-latin-ext-700-normal.woff2",
  "assets/courier-prime-latin-400-normal.woff2",
  "assets/courier-prime-latin-ext-400-normal.woff2",
  "assets/courier-prime-latin-700-normal.woff2",
  "assets/tmdb-logo.svg",
  "__l5e/assets-v1/8a9f592b-23da-4698-8a14-e0016a7b6c74/cinefil-logo.png"
].map((path) => new URL(path, BASE_URL).href);
const OPTIONAL = [
  "src/data/tmdb-portraits.json",
].map((path) => new URL(path, BASE_URL).href);

// A fresh worker must fill its cache from the network. Without "reload" the browser is allowed to answer from
// its own HTTP cache, so a just-published deployment could be re-cached as the previous one for ten minutes.
const freshRequest = (url) => new Request(url, { cache: "reload" });

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(async (cache) => {
      await cache.addAll(CORE.map(freshRequest));
      await Promise.allSettled(OPTIONAL.map((url) => cache.add(freshRequest(url))));
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
