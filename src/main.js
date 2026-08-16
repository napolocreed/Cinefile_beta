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

// L'écran de chargement du document n'a rien qui l'enlève : si le démarrage jette, la page reste indéfiniment sur
// « Chargement de la bobine… », sans le moindre message. Le repli sur l'ancien instantané ne vérifiait pas non plus
// son propre statut, si bien qu'une page d'erreur HTML le faisait échouer sur un JSON illisible.
function bootFailure(error) {
  diagnostics.capture(error, { phase: "boot" });
  if (!root) return;
  root.innerHTML = `<main class="screen empty-state">
    <span class="stamp stamp--rouge">Bobine coincée</span>
    <h1 class="marquee">Le catalogue n’a pas pu être chargé</h1>
    <p class="prose">Le fichier du catalogue est introuvable ou illisible. Vérifiez votre connexion, puis relancez.</p>
    <button class="button button--gold" type="button" data-boot-retry>Réessayer</button>
  </main>`;
  root.querySelector("[data-boot-retry]")?.addEventListener("click", () => window.location.reload());
}

const readJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
};

let data;
let synonyms;
let portraits;
try {
  [data, synonyms, portraits] = await Promise.all([
    readJson(assetUrl("src/data/cinema-knowledge.json"))
      .catch(() => readJson(assetUrl("src/data/cinema-database.json"))),
    readJson(assetUrl("src/data/cinema-synonyms.json")).catch(() => ({ people: [], works: [] })),
    // Portraits are a nicety: a failed fetch costs an engraved initial, never a broken screen.
    readJson(assetUrl("src/data/tmdb-portraits.json")).catch(() => null),
  ]);
} catch (error) {
  bootFailure(error);
  throw error;
}

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
