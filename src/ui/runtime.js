// The shared ground floor of the interface: the services the boot sequence built, the mutable screen state, and
// two indirections — render and navigate — that let a screen ask for a repaint without importing the router.
// Nothing here imports a screen, so the module graph stays acyclic.

import { buildCredits, creditsSignature } from "../game/credits.js";
import { createVoiceState } from "./voice-state.js";

// Filled once by main.js. Screens read it; nothing else writes to it.
export const app = {
  root: null,
  database: null,
  catalog: null,
  storage: null,
  diagnostics: null,
  basePath: "/",
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
  catalogStatus: { checked: false, configured: null, online: true },
  verificationStatus: "idle",
  voice: createVoiceState(),
  transferNotice: null,
  // The end credits, kept one turn ahead of the players. See queueCreditsRefresh below.
  credits: null,
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

/* -----------------------------------------------------------------------------
   The credits, assembled between two turns
   -------------------------------------------------------------------------- */

// Reading the whole log back — and asking the archive about every link the engine could not prove — is work that
// has no business happening while a player is waiting to see the winner. So it happens during the game instead,
// on idle time after each committed turn: by the time the last life goes, the roll is already built.
let cancelCreditsBuild = null;

function buildCreditsNow(game) {
  cancelCreditsBuild = null;
  state.credits = buildCredits(game, { database: app.database });
}

export function queueCreditsRefresh(game = state.game) {
  if (!game) return;
  if (state.credits?.signature === creditsSignature(game)) return;
  cancelCreditsBuild?.();
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => buildCreditsNow(game), { timeout: 1500 });
    cancelCreditsBuild = () => window.cancelIdleCallback(handle);
  } else {
    const handle = window.setTimeout(() => buildCreditsNow(game), 0);
    cancelCreditsBuild = () => window.clearTimeout(handle);
  }
}

// What the credits screen asks for. A hit costs nothing; a miss — a reloaded game, a roll asked for twice —
// builds on the spot rather than showing an empty stage.
export function creditsFor(game = state.game) {
  if (!game) return null;
  if (state.credits?.signature === creditsSignature(game)) return state.credits;
  cancelCreditsBuild?.();
  buildCreditsNow(game);
  return state.credits;
}

// The line follows the state of the API, never the build: hors ligne, the snapshot alone still plays, and saying
// which catalogue is actually answering is what keeps that from looking like a failure.
export function catalogStatusLabel() {
  const status = state.catalogStatus;
  if (status.online === false) return "Hors connexion · base locale";
  if (status.configured === false) return "Serveur Ciné-Fil · base locale";
  return status.configured ? "Serveur Ciné-Fil · TMDb en direct" : "Serveur Ciné-Fil · vérification…";
}

export function refreshCatalogLabel() {
  const label = document.querySelector("[data-catalog-label]");
  if (label) label.textContent = catalogStatusLabel();
}

export function setCatalogStatus(status) {
  state.catalogStatus = status;
  refreshCatalogLabel();
}
