// The route table. It owns navigation and the single repaint entry point; every screen reaches both through the
// runtime's indirection rather than by importing this module back.

import {
  app,
  path,
  routeUrl,
  setHooks,
  state,
  stopSearch,
  stopTimer,
  logicalPath,
} from "./runtime.js";
import { renderHome } from "./screens/home.js";
import { bindSetup, setupMarkup } from "./screens/setup.js";
import { bindPlay, playMarkup } from "./screens/play.js";
import { renderResults } from "./screens/results.js";
import { renderProfiles } from "./screens/profiles.js";
import { stopVoiceSession } from "./screens/voice.js";

export function navigate(target) {
  const destination = new URL(target, window.location.origin);
  const logicalTarget = logicalPath(destination.pathname);
  stopTimer();
  stopSearch();
  if (logicalTarget !== "/play" && state.voice?.session) stopVoiceSession();
  history.pushState({}, "", routeUrl(logicalTarget));
  // The turn starts on the field the player needs; there is no hand-over screen to pass through any more.
  state.phase = "input";
  state.pending = null;
  state.revealChallenged = false;
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
      navigate(state.game?.status === "finished" ? "/results" : "/");
      return;
    }
    app.root.innerHTML = playMarkup();
    bindPlay();
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
