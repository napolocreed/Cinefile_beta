// The shared ground floor of the interface: the services the boot sequence built, the mutable screen state, and
// two indirections — render and navigate — that let a screen ask for a repaint without importing the router.
// Nothing here imports a screen, so the module graph stays acyclic.

import { createVoiceState } from "./voice-state.js";

// Filled once by main.js. Screens read it; nothing else writes to it.
export const app = {
  root: null,
  database: null,
  catalog: null,
  storage: null,
  diagnostics: null,
  basePath: "/",
  remoteCatalog: false,
  apiHost: "",
  buildStamp: "développement local",
};

export function configureApp(values) {
  Object.assign(app, values);
}

export const assetUrl = (value = "") => `${app.basePath}${String(value).replace(/^\/+/, "")}`;

export const routeUrl = (value = "/") => {
  const logical = `/${String(value).replace(/^\/+|\/+$/g, "")}`;
  return logical === "/" ? app.basePath : assetUrl(logical);
};

export const logicalPath = (pathname = window.location.pathname) => {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const baseWithoutSlash = app.basePath.replace(/\/+$/, "") || "/";
  if (normalizedPathname === baseWithoutSlash) return "/";
  if (app.basePath !== "/" && normalizedPathname.startsWith(app.basePath)) {
    return `/${normalizedPathname.slice(app.basePath.length).replace(/^\/+|\/+$/g, "")}`;
  }
  return normalizedPathname;
};

export const path = () => logicalPath();

export const state = {
  game: null,
  setup: null,
  phase: "input",
  pending: null,
  revealChallenged: false,
  input: "",
  timeLeft: null,
  timer: null,
  // The name of the player the screen has just been handed to, announced once and then cleared.
  handoff: null,
  newAchievements: [],
  suggestions: [],
  selectedPerson: null,
  searchStatus: "idle",
  searchTimer: null,
  searchAbort: null,
  submitting: false,
  catalogStatus: { mode: "local", configured: false, online: true, static: false },
  verificationStatus: "idle",
  voice: createVoiceState(),
  transferNotice: null,
};

// Late-bound so a screen can trigger a repaint or a route change without depending on the router module.
const hooks = {
  render: () => {},
  navigate: () => {},
};

export function setHooks(values) {
  Object.assign(hooks, values);
}

export const renderRoute = () => hooks.render();
export const navigate = (target) => hooks.navigate(target);

export function stopTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
}

export function stopSearch() {
  if (state.searchTimer) window.clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.searchAbort?.abort();
  state.searchAbort = null;
}

// Three deployments, three truths: the snapshot alone, a borrowed API origin, or this deployment's own server.
// The line has to follow the state and not the build, or a borrowed catalogue would keep claiming to be offline.
export function catalogStatusLabel() {
  const status = state.catalogStatus;
  if (status.mode === "local" || status.static) return "Catalogue embarqué";
  const place = status.mode === "borrowed" ? "Catalogue emprunté" : "Serveur Ciné-Fil";
  if (status.online === false) return "Hors connexion · base locale";
  if (status.configured === false) return `${place} · base locale`;
  return status.configured ? `${place} · TMDb en direct` : `${place} · vérification…`;
}

export function refreshCatalogLabel() {
  const label = document.querySelector("[data-catalog-label]");
  if (label) label.textContent = catalogStatusLabel();
}

export function setCatalogStatus(status) {
  state.catalogStatus = status;
  refreshCatalogLabel();
}
