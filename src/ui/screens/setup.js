// Pre-production, folded onto a single phone screen. The numbered panels, their decorative subtitles and the
// set-choice section are gone: what remains is the cast, how names are entered, and two dials.
//
// Under the cast list sits the contact sheet: the profiles already on file, one tap away from a seat. It sits
// *under* the list on purpose — the name it writes appears above the finger, never hidden by the hand.

import { normalizeText } from "../../game/database.js";
import { createGame } from "../../game/engine.js";
import { castingRoster } from "../../game/storage.js";
import { app, navigate, renderRoute, state } from "../runtime.js";
import { escapeHtml, initialOf } from "../format.js";
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

// Six vignettes tiennent en trois lignes sur un écran de 390 px sans pousser les réglages hors de vue. Au-delà,
// le reste part dans un dépliant, et un champ de filtre apparaît quand la liste cesse de se parcourir à l'œil.
const VISIBLE_CHIPS = 6;
const FILTER_FROM = 7;

const seatKeys = (names) => names.map((name) => normalizeText(name));
const filledSeats = (names) => seatKeys(names).filter(Boolean);
const maxSeats = (setup) => (setup.mode === "voice" ? 2 : 10);
const castingIsFull = (setup) => filledSeats(setup.names).length >= maxSeats(setup);

/* -----------------------------------------------------------------------------
   La planche de contact
   -------------------------------------------------------------------------- */

function chipLabel(name, games, selected, disabled) {
  const played = games > 0 ? `${games} partie${games > 1 ? "s" : ""}` : "aucune partie";
  const action = selected ? "Retirer du casting" : disabled ? "Casting complet" : "Ajouter au casting";
  return `${name}, ${played}. ${action}.`;
}

function chipMarkup({ key, profile }, { selected, full, detailed = false }) {
  const disabled = full && !selected;
  return `<li><button type="button"
    class="casting-chip${selected ? " casting-chip--selected" : ""}${profile.games ? "" : " casting-chip--fresh"}"
    data-profile-key="${escapeHtml(key)}"
    data-profile-name="${escapeHtml(profile.name)}"
    data-profile-games="${profile.games}"
    aria-pressed="${selected}"${disabled ? " disabled" : ""}
    aria-label="${escapeHtml(chipLabel(profile.name, profile.games, selected, disabled))}"
    ><span class="casting-chip__initial" aria-hidden="true">${initialOf(profile.name)}</span
    ><span class="casting-chip__name">${escapeHtml(profile.name)}</span
    >${detailed ? `<span class="casting-chip__meta" aria-hidden="true">${profile.games || "—"}</span>` : ""}</button></li>`;
}

function castingMarkup(setup) {
  const selectedKeys = filledSeats(setup.names);
  const { shown, hidden } = castingRoster(app.storage.loadProfiles(), selectedKeys, { visible: VISIBLE_CHIPS });
  if (!shown.length) {
    return `<p class="fineprint">Les noms saisis ici deviennent des profils : on les retrouvera à la prochaine partie.</p>`;
  }
  const full = castingIsFull(setup);
  const chip = (entry, detailed) => chipMarkup(entry, { selected: selectedKeys.includes(entry.key), full, detailed });
  return `<div class="casting-call">
    <p class="slug" id="casting-call-label">Déjà à l’affiche</p>
    <ul class="casting-chips" aria-labelledby="casting-call-label">${shown.map((entry) => chip(entry, false)).join("")}</ul>
    ${hidden.length ? `<details class="fold casting-fold">
      <summary>${hidden.length > 1 ? `Les ${hidden.length} autres profils` : "Un autre profil"}</summary>
      <div class="fold__body">
        ${hidden.length >= FILTER_FROM ? `<label class="sr-only" for="casting-filter">Filtrer les profils enregistrés</label>
        <input id="casting-filter" class="field" type="search" placeholder="Filtrer par nom…" autocomplete="off" data-casting-filter>` : ""}
        <ul class="casting-list" aria-label="Tous les profils enregistrés">${hidden.map((entry) => chip(entry, true)).join("")}</ul>
        <p class="fineprint" data-casting-empty hidden>Aucun profil ne porte ce nom.</p>
      </div>
    </details>` : ""}
  </div>`;
}

/* -----------------------------------------------------------------------------
   L'écran
   -------------------------------------------------------------------------- */

export function setupMarkup() {
  const setup = state.setup ?? { ...DEFAULT_SETUP, names: [...DEFAULT_SETUP.names] };
  setup.mode ??= "classic";
  setup.themeId ??= "classic";
  state.setup = setup;

  const removable = setup.mode !== "voice" && setup.names.length > 2;
  const names = setup.names.map((name, index) => `<div class="player-row"><span class="player-row__number">${String(index + 1).padStart(2, "0")}</span><input class="field" data-player-index="${index}" value="${escapeHtml(name)}" placeholder="Nom du joueur ${index + 1}" maxlength="24" autocomplete="off">${removable ? `<button class="icon-button" data-remove-player="${index}" aria-label="Retirer ${escapeHtml(name || `le joueur ${index + 1}`)}">×</button>` : ""}</div>`).join("");
  // Le compteur comptait des lignes ; il compte désormais des noms, qui est ce que la table lit.
  const filled = filledSeats(setup.names).length;

  return shell(`<section class="screen setup">
    <h1 class="marquee">Nouvelle partie</h1>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">Le casting</span><span class="slug" data-casting-count aria-label="${filled} joueur${filled > 1 ? "s" : ""} sur ${maxSeats(setup)}">${String(filled).padStart(2, "0")} / ${String(maxSeats(setup)).padStart(2, "0")}</span></div>
      <div class="players-list">${names}</div>
      ${castingMarkup(setup)}
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
      <p class="casting-hint" data-casting-hint aria-live="polite"></p>
      <button class="button button--gold button--wide" data-start-game>Lancer la partie <span aria-hidden="true">→</span></button>
    </div>
  </section>`, { back: "/" });
}

/* -----------------------------------------------------------------------------
   L'état du casting, dit plutôt que subi
   -------------------------------------------------------------------------- */

// Le bouton était déjà désactivé sur un doublon, mais sans jamais dire pourquoi. Un seul juge décide donc de
// tout : le bouton, la raison, les champs fautifs et l'état des vignettes.
function castingVerdict() {
  const setup = state.setup;
  const keys = filledSeats(setup.names);
  const doubles = new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  if (doubles.size) return { blocked: true, doubles, message: "Deux joueurs portent le même nom : changez-en un." };
  if (setup.mode === "voice" && keys.length !== 2) return { blocked: true, doubles, message: "Le vocal se joue à deux, pas un de plus." };
  if (keys.length < 2) return { blocked: true, doubles, message: "Il faut deux noms pour lancer la partie." };
  if (castingIsFull(setup)) return { blocked: false, doubles, message: setup.mode === "voice" ? "Les deux sièges sont pris." : "Casting complet : dix noms." };
  return { blocked: false, doubles, message: "" };
}

function syncChips() {
  const keys = new Set(filledSeats(state.setup.names));
  const full = castingIsFull(state.setup);
  for (const chip of document.querySelectorAll("[data-profile-key]")) {
    const selected = keys.has(chip.dataset.profileKey);
    const disabled = full && !selected;
    chip.classList.toggle("casting-chip--selected", selected);
    chip.setAttribute("aria-pressed", String(selected));
    chip.disabled = disabled;
    chip.setAttribute("aria-label", chipLabel(chip.dataset.profileName, Number(chip.dataset.profileGames), selected, disabled));
  }
}

function refreshCasting() {
  const verdict = castingVerdict();
  const button = document.querySelector("[data-start-game]");
  if (button) button.disabled = verdict.blocked;

  const hint = document.querySelector("[data-casting-hint]");
  if (hint) {
    hint.textContent = verdict.message;
    hint.classList.toggle("casting-hint--doublon", verdict.doubles.size > 0);
  }

  state.setup.names.forEach((name, index) => {
    const field = document.querySelector(`[data-player-index="${index}"]`);
    if (!field) return;
    const guilty = verdict.doubles.has(normalizeText(name));
    field.classList.toggle("field--doublon", guilty);
    field.toggleAttribute("aria-invalid", guilty);
  });

  const counter = document.querySelector("[data-casting-count]");
  if (counter) {
    const filled = filledSeats(state.setup.names).length;
    counter.textContent = `${String(filled).padStart(2, "0")} / ${String(maxSeats(state.setup)).padStart(2, "0")}`;
    counter.setAttribute("aria-label", `${filled} joueur${filled > 1 ? "s" : ""} sur ${maxSeats(state.setup)}`);
  }

  syncChips();
}

/* -----------------------------------------------------------------------------
   Les gestes
   -------------------------------------------------------------------------- */

// Un tap remplit la première ligne vide de haut en bas ; retaper une vignette déjà retenue libère son siège.
// En classique, une planche pleine allonge le casting plutôt que de demander d'abord « ＋ Ajouter un joueur ».
function toggleSeat(key, name) {
  const setup = state.setup;
  const keys = seatKeys(setup.names);
  const taken = keys.indexOf(key);
  if (taken >= 0) {
    if (setup.mode === "classic" && setup.names.length > 2) setup.names.splice(taken, 1);
    else setup.names[taken] = "";
  } else {
    const free = keys.indexOf("");
    if (free >= 0) setup.names[free] = name;
    else if (setup.mode === "classic" && setup.names.length < 10) setup.names.push(name);
    else return;
  }
  // Le repeint est complet, comme pour l'ajout et le retrait d'une ligne ; le focus est rendu ensuite.
  state.setup.focusKey = key;
  renderRoute();
}

function bindCastingFilter() {
  const filter = document.querySelector("[data-casting-filter]");
  if (!filter) return;
  const rows = [...document.querySelectorAll(".casting-list > li")];
  const empty = document.querySelector("[data-casting-empty]");
  filter.addEventListener("input", () => {
    // Aucune requête, aucun repeint : on masque des lignes déjà rendues. « zoe » retrouve « Zoé ».
    const needle = normalizeText(filter.value);
    let visible = 0;
    for (const row of rows) {
      const key = row.querySelector("[data-profile-key]")?.dataset.profileKey ?? "";
      const match = !needle || key.includes(needle);
      row.hidden = !match;
      if (match) visible += 1;
    }
    if (empty) empty.hidden = visible > 0;
  });
}

export function bindSetup() {
  state.setup.names.forEach((_, index) => {
    document.querySelector(`[data-player-index="${index}"]`)?.addEventListener("input", (event) => {
      state.setup.names[index] = event.target.value;
      // Jamais de repeint sur une frappe : le curseur y resterait. Les vignettes se mettent à jour sur place.
      refreshCasting();
    });
  });

  document.querySelectorAll("[data-profile-key]").forEach((chip) => chip.addEventListener("click", () => {
    toggleSeat(chip.dataset.profileKey, chip.dataset.profileName);
  }));

  bindCastingFilter();

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
    const typed = state.setup.names.map((name) => name.trim()).filter(Boolean);
    if (castingVerdict().blocked) return;
    // Un nom monté sur la feuille de casting est un profil à partir de cet instant, même si la partie est
    // abandonnée — et il rend son orthographe de référence : « alice » tapé ce soir rejoue sous « Alice ».
    const names = typed.map((name) => app.storage.rememberProfile(name)?.name ?? name);
    state.game = createGame({ names, config: state.setup });
    stopVoiceSession();
    state.voice = createVoiceState();
    app.storage.saveCurrent(state.game);
    navigate("/play");
  });

  // Après un repeint complet, le focus repart au corps du document : un utilisateur clavier recommencerait en
  // haut de page à chaque sélection. On le rend à la vignette qu'il vient d'actionner.
  if (state.setup.focusKey) {
    const key = state.setup.focusKey;
    state.setup.focusKey = null;
    [...document.querySelectorAll("[data-profile-key]")]
      .find((chip) => chip.dataset.profileKey === key)?.focus({ preventScroll: true });
  }

  refreshCasting();
}
