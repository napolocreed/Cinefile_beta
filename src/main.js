// Boot. Reads the deployment's own description out of the document, loads the catalogue snapshot, builds the
// services, then hands over to the router. Everything else lives under src/ui/.

import { createDatabase } from "./game/database.js";
import { createHybridCatalog, normalizeApiBase } from "./game/catalog.js";
import { createStaticOverlay } from "./game/static-overlay.js";
import { createStorage } from "./game/storage.js";
import { createDiagnostics } from "./game/diagnostics.js";
import { configureApp, setCatalogStatus, state } from "./ui/runtime.js";
import { installPortraitFallback } from "./ui/format.js";
import { installRouter, renderRoute } from "./ui/router.js";
import { renderSuggestions } from "./ui/screens/play.js";

function normalizeBasePath(value) {
  const clean = `/${String(value ?? "/").trim().replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/" : `${clean}/`;
}

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;

const basePath = normalizeBasePath(meta("app-base") ?? "/");
const catalogMode = meta("catalog-mode") === "static" ? "static" : "remote";
// A static build has no server of its own, but it can be pointed at a deployed one. An empty or malformed value
// leaves the edition exactly as it was: snapshot only, no call, no promise made to the player.
const apiBase = normalizeApiBase(meta("api-base") ?? "");
const remoteCatalog = catalogMode === "remote" || Boolean(apiBase);

const assetUrl = (value = "") => `${basePath}${String(value).replace(/^\/+/, "")}`;

const root = document.querySelector("#app");
const storage = createStorage();
const diagnostics = createDiagnostics();
diagnostics.install(window);
document.documentElement.toggleAttribute("data-large-text", storage.loadSettings().largeText === true);

const [data, synonyms, overlay, portraits] = await Promise.all([
  fetch(assetUrl("src/data/cinema-knowledge.json"))
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("snapshot")))
    .catch(() => fetch(assetUrl("src/data/cinema-database.json")).then((response) => response.json())),
  fetch(assetUrl("src/data/cinema-synonyms.json")).then((response) => response.json()).catch(() => ({ people: [], works: [] })),
  catalogMode === "static"
    ? fetch(assetUrl("src/data/tmdb-overlay-index.json"))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("overlay")))
      .catch(() => ({ version: 1, people: [] }))
    : Promise.resolve({ version: 1, people: [] }),
  // The static edition already carries portraits in its overlay index; the server edition loads them alone.
  catalogMode === "static"
    ? Promise.resolve(null)
    : fetch(assetUrl("src/data/tmdb-portraits.json")).then((response) => response.ok ? response.json() : null).catch(() => null),
]);

const database = createDatabase(data, { synonyms });
const staticOverlay = catalogMode === "static"
  ? createStaticOverlay({ database, index: overlay, resolveAsset: assetUrl })
  : null;
if (portraits) database.attachPortraits(portraits);

const catalog = createHybridCatalog({
  database,
  remoteEnabled: remoteCatalog,
  staticHydrate: staticOverlay?.hydrate,
  apiBase,
});

configureApp({
  root,
  database,
  catalog,
  storage,
  diagnostics,
  basePath,
  remoteCatalog,
  apiHost: apiBase ? new URL(apiBase).host : "",
  buildStamp: meta("build-stamp") || "développement local",
});

state.game = storage.loadCurrent();
state.catalogStatus = catalog.getState();

installPortraitFallback();
installRouter();
renderRoute();

catalog.status().then((status) => {
  setCatalogStatus(status);
  if (state.phase === "input") renderSuggestions();
});

if ("serviceWorker" in navigator) {
  const registerServiceWorker = () => navigator.serviceWorker
    .register(assetUrl("sw.js"), { scope: basePath })
    .catch((error) => diagnostics.capture(error, { phase: "service-worker" }));
  if (document.readyState === "complete") registerServiceWorker();
  else window.addEventListener("load", registerServiceWorker, { once: true });
}
