// Boot. Reads the deployment's own description out of the document, loads the catalogue snapshot, builds the
// services, then hands over to the router. Everything else lives under src/ui/.
//
// The snapshot is fetched before anything is drawn, and it is what makes the game playable with no network at
// all: the server enriches it, it never replaces it.

import { createDatabase } from "./game/database.js";
import { createHybridCatalog } from "./game/catalog.js";
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

// The app does not assume it is served from the root: a deployment can mount it under a path prefix.
const basePath = normalizeBasePath(meta("app-base") ?? "/");
const assetUrl = (value = "") => `${basePath}${String(value).replace(/^\/+/, "")}`;

const root = document.querySelector("#app");
const storage = createStorage();
const diagnostics = createDiagnostics();
diagnostics.install(window);
document.documentElement.toggleAttribute("data-large-text", storage.loadSettings().largeText === true);

const [data, synonyms, portraits] = await Promise.all([
  fetch(assetUrl("src/data/cinema-knowledge.json"))
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("snapshot")))
    .catch(() => fetch(assetUrl("src/data/cinema-database.json")).then((response) => response.json())),
  fetch(assetUrl("src/data/cinema-synonyms.json")).then((response) => response.json()).catch(() => ({ people: [], works: [] })),
  // Portraits are a nicety: a failed fetch costs an engraved initial, never a broken screen.
  fetch(assetUrl("src/data/tmdb-portraits.json")).then((response) => response.ok ? response.json() : null).catch(() => null),
]);

const database = createDatabase(data, { synonyms });
if (portraits) database.attachPortraits(portraits);

const catalog = createHybridCatalog({ database });

configureApp({
  root,
  database,
  catalog,
  storage,
  diagnostics,
  basePath,
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
