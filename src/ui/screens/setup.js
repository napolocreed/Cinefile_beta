// Pre-production, folded onto a single phone screen. The numbered panels, their decorative subtitles and the
// set-choice section are gone: what remains is the cast, how names are entered, and two dials.

import { normalizeText } from "../../game/database.js";
import { createGame } from "../../game/engine.js";
import { app, navigate, renderRoute, state } from "../runtime.js";
import { escapeHtml } from "../format.js";
import { shell } from "../shell.js";
import { createVoiceState } from "../voice-state.js";
import { stopVoiceSession } from "./voice.js";

const DEFAULT_SETUP = {
  names: ["", ""],
  themeId: "classic",
  mode: "classic",
  livesPerPlayer: 3,
  turnSeconds: 30,
  allowBluffChallenge: true,
};

export function setupMarkup() {
  const setup = state.setup ?? { ...DEFAULT_SETUP, names: [...DEFAULT_SETUP.names] };
  setup.mode ??= "classic";
  setup.themeId ??= "classic";
  state.setup = setup;

  const removable = setup.mode !== "voice" && setup.names.length > 2;
  const names = setup.names.map((name, index) => `<div class="player-row"><span class="player-row__number">${String(index + 1).padStart(2, "0")}</span><input class="field" data-player-index="${index}" value="${escapeHtml(name)}" placeholder="Nom du joueur ${index + 1}" maxlength="24" autocomplete="off">${removable ? `<button class="icon-button" data-remove-player="${index}" aria-label="Retirer ${escapeHtml(name || `le joueur ${index + 1}`)}">×</button>` : ""}</div>`).join("");

  return shell(`<section class="screen setup">
    <h1 class="marquee">Nouvelle partie</h1>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">Le casting</span><span class="slug">${String(setup.names.length).padStart(2, "0")} / ${setup.mode === "voice" ? "02" : "10"}</span></div>
      <div class="players-list">${names}</div>
      ${setup.mode === "classic" && setup.names.length < 10 ? `<button class="add-player" data-add-player>＋ Ajouter un joueur</button>` : ""}
    </div>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">La prise</span></div>
      <div class="mode-grid">
        <button class="mode-card ${setup.mode === "classic" ? "mode-card--selected" : ""}" data-mode="classic"><span class="mode-card__icon" aria-hidden="true">⌨</span><b>Classique</b><small>Saisie et passage d’écran</small></button>
        <button class="mode-card ${setup.mode === "voice" ? "mode-card--selected" : ""}" data-mode="voice"><span class="mode-card__icon" aria-hidden="true">◉</span><b>Vocal passif</b><small>Deux joueurs, buzzer central</small></button>
      </div>
    </div>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">Les règles</span></div>
      <div class="rules-grid">
        <div class="dial">
          <label class="dial__label" for="lives-range">Vies</label>
          <strong class="dial__value" id="lives-value">${setup.livesPerPlayer}</strong>
          <input id="lives-range" type="range" min="1" max="5" value="${setup.livesPerPlayer}">
        </div>
        <div class="dial">
          <label class="dial__label" for="timer-range">Chrono</label>
          <strong class="dial__value" id="timer-value">${setup.turnSeconds === 0 ? "∞" : `${setup.turnSeconds}s`}</strong>
          <input id="timer-range" type="range" min="5" max="60" step="5" value="${setup.turnSeconds || 30}" ${setup.turnSeconds === 0 ? "disabled" : ""}>
        </div>
      </div>
      <div class="rules-grid">
        <label class="check-row"><input id="no-timer" type="checkbox" ${setup.turnSeconds === 0 ? "checked" : ""}><span>Sans chrono</span></label>
        <label class="check-row"><input id="allow-bluff" type="checkbox" ${setup.allowBluffChallenge ? "checked" : ""}><span>Défis de bluff</span></label>
      </div>
    </div>

    <div class="screen__spacer"></div>
    <div class="screen__foot">
      <button class="button button--gold button--wide" data-start-game>Lancer la partie <span aria-hidden="true">→</span></button>
    </div>
  </section>`, { back: "/" });
}

export function bindSetup() {
  state.setup.names.forEach((_, index) => {
    document.querySelector(`[data-player-index="${index}"]`)?.addEventListener("input", (event) => {
      state.setup.names[index] = event.target.value;
      updateSetupButton();
    });
  });

  document.querySelector("[data-add-player]")?.addEventListener("click", () => {
    if (state.setup.names.length < 10) {
      state.setup.names.push("");
      renderRoute();
    }
  });

  document.querySelectorAll("[data-remove-player]").forEach((button) => button.addEventListener("click", () => {
    state.setup.names.splice(Number(button.dataset.removePlayer), 1);
    renderRoute();
  }));

  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.setup.mode = button.dataset.mode;
    if (state.setup.mode === "voice") state.setup.names = [...state.setup.names.slice(0, 2), "", ""].slice(0, 2);
    renderRoute();
  }));

  const livesRange = document.querySelector("#lives-range");
  livesRange?.addEventListener("input", () => {
    state.setup.livesPerPlayer = Number(livesRange.value);
    document.querySelector("#lives-value").textContent = livesRange.value;
  });

  const timerRange = document.querySelector("#timer-range");
  timerRange?.addEventListener("input", () => {
    state.setup.turnSeconds = Number(timerRange.value);
    document.querySelector("#timer-value").textContent = `${timerRange.value}s`;
  });

  document.querySelector("#no-timer")?.addEventListener("change", (event) => {
    state.setup.turnSeconds = event.target.checked ? 0 : 30;
    renderRoute();
  });

  document.querySelector("#allow-bluff")?.addEventListener("change", (event) => {
    state.setup.allowBluffChallenge = event.target.checked;
  });

  document.querySelector("[data-start-game]")?.addEventListener("click", () => {
    const names = state.setup.names.map((name) => name.trim()).filter(Boolean);
    if (names.length < 2 || (state.setup.mode === "voice" && names.length !== 2)) return;
    state.game = createGame({ names, config: state.setup });
    stopVoiceSession();
    state.voice = createVoiceState();
    app.storage.saveCurrent(state.game);
    navigate("/play");
  });

  updateSetupButton();
}

function updateSetupButton() {
  const button = document.querySelector("[data-start-game]");
  const cleanNames = state.setup.names.map((name) => normalizeText(name)).filter(Boolean);
  const enough = state.setup.mode === "voice" ? cleanNames.length === 2 : cleanNames.length >= 2;
  if (button) button.disabled = !enough || new Set(cleanNames).size !== cleanNames.length;
}
