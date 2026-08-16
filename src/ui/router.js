// The route table. It owns navigation and the single repaint entry point; every screen reaches both through the
// runtime's indirection rather than by importing this module back.

import { resolvePending } from "../game/engine.js";
import {
  app,
  archiveFinishedGame,
  bumpGeneration,
  path,
  routeUrl,
  setHooks,
  state,
  stopSearch,
  stopTimer,
  logicalPath,
} from "./runtime.js";
import { renderCredits, stopCredits } from "./screens/credits.js";
import { renderHome } from "./screens/home.js";
import { bindSetup, setupMarkup } from "./screens/setup.js";
import { bindPlay, playMarkup } from "./screens/play.js";
import { renderResults } from "./screens/results.js";
import { renderProfiles } from "./screens/profiles.js";
import { stopVoiceSession } from "./screens/voice.js";

// Un coup en attente est un coup déjà joué, et la vie qu'il coûte est due. Rien ne le persistait : navigate()
// l'effaçait, si bien qu'un aller-retour par « ← Accueil » annulait un chrono expiré — et, quand ce coup terminait
// la partie, annulait la partie gagnée elle-même. On le règle donc avant de quitter l'écran, exactement tel qu'il
// s'y affichait : une proposition que personne n'a contestée est une proposition acceptée.
function settlePendingBeforeLeaving() {
  if (!state.pending || !state.game) return;
  const pending = state.pending;
  state.pending = null;
  const resolved = resolvePending(state.game, pending, { challenged: state.revealChallenged });
  state.game = resolved;
  app.storage.saveCurrent(resolved);
  if (resolved.status === "finished") archiveFinishedGame(resolved);
}

export function navigate(target, { replace = false } = {}) {
  const destination = new URL(target, window.location.origin);
  const logicalTarget = logicalPath(destination.pathname);
  stopTimer();
  stopSearch();
  settlePendingBeforeLeaving();
  // Ce qui est parti sur le réseau depuis l'écran qu'on quitte n'a plus rien à y écrire.
  bumpGeneration();
  if (logicalTarget !== "/play" && state.voice?.session) stopVoiceSession();
  // Un renvoi automatique ne doit pas empiler une entrée d'historique : le bouton Retour du navigateur y revenait
  // aussitôt, et la table restait piégée sur le générique sans pouvoir en sortir par ce geste.
  if (replace) history.replaceState({}, "", routeUrl(logicalTarget));
  else history.pushState({}, "", routeUrl(logicalTarget));
  // The turn starts on the field the player needs; there is no hand-over screen to pass through any more.
  state.phase = "input";
  state.pending = null;
  state.revealChallenged = false;
  // L'écran de revue du buzzer survivait à la navigation : ses trois boutons passent tous par state.pending, qui
  // venait d'être vidé, et il ne rendait plus aucun autre lien que « ← Accueil ». La table restait bloquée dessus
  // à chaque retour, sans autre issue qu'un rechargement complet.
  if (state.voice) {
    state.voice.review = null;
    state.voice.outcome = null;
  }
  state.input = "";
  state.suggestions = [];
  state.selectedPerson = null;
  state.timeLeft = null;
  state.handoff = null;
  renderRoute();
  window.scrollTo(0, 0);
  app.root.focus({ preventScroll: true });
}

export function renderRoute() {
  stopTimer();
  // The credits listen on the document, so they are dismissed by every repaint — including a back button, which
  // never goes through navigate().
  stopCredits();
  const currentPath = path();

  if (currentPath === "/setup") {
    app.root.innerHTML = setupMarkup();
    bindSetup();
    return;
  }

  if (currentPath === "/play") {
    // Only adopt the stored game when this session has none. Re-reading on every render would roll back a move
    // that is already applied in memory but not yet persisted, destroying it along with the pending proposition.
    state.game ??= app.storage.loadCurrent();
    // A finished game normally jumps to the credits, but a buzz that ended it still owes the table its verdict.
    if (!state.game || (state.game.status === "finished" && !state.voice?.outcome)) {
      navigate(state.game?.status === "finished" ? "/credits" : "/", { replace: true });
      return;
    }
    app.root.innerHTML = playMarkup();
    bindPlay();
    return;
  }

  // The credits roll between the last life and the scoreboard, and they own the whole screen while they do.
  if (currentPath === "/credits") {
    renderCredits();
    return;
  }

  if (currentPath === "/results") {
    renderResults();
    return;
  }

  if (currentPath === "/profiles") {
    renderProfiles();
    return;
  }

  renderHome();
}

export function installRouter() {
  setHooks({ render: renderRoute, navigate });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-nav]");
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
  });

  window.addEventListener("popstate", renderRoute);
}
