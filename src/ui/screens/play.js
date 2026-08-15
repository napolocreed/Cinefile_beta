// The classic turn. The dedicated "hand the screen over" page is gone: it cost a full screen and a tap to say
// what the reel counter already says. The hand-over now plays as a clap on the counter itself, on the screen the
// player actually needs — the one where they type.

import { normalizeText } from "../../game/database.js";
import {
  adjudicatePending,
  applyLinkVerification,
  currentPlayer,
  proposeActor,
  resolvePending,
  timeoutPending,
} from "../../game/engine.js";
import {
  app,
  archiveFinishedGame,
  navigate,
  queueCreditsRefresh,
  renderRoute,
  setCatalogStatus,
  state,
  stopSearch,
  stopTimer,
} from "../runtime.js";
import { describeExtensions } from "../../game/work-kinds.js";
import { connectionMarkup, escapeHtml, livesMarkup, pictureMarkup, portraitMarkup, roleLabel } from "../format.js";
import { verifyPendingLink } from "../link-check.js";
import { shell } from "../shell.js";
import { verificationCascadeMarkup, verificationPanelMarkup, verificationSourceLabel } from "../verification.js";
import { voiceMarkup, bindVoice } from "./voice.js";

/* -----------------------------------------------------------------------------
   The reel counter
   -------------------------------------------------------------------------- */

function reelCounter({ fresh = false } = {}) {
  const player = currentPlayer(state.game);
  const timer = state.timeLeft === null
    ? (state.game.config.turnSeconds ? `${state.game.config.turnSeconds}s` : "∞")
    : `${state.timeLeft}s`;
  const urgent = state.timeLeft !== null && state.timeLeft <= 5;
  return `<div class="reel-counter ${fresh ? "reel-counter--fresh" : ""}">
    <div class="reel-counter__cell"><span class="slug">Chaîne</span><strong>${state.game.chain.length}</strong></div>
    <div class="reel-counter__who"><span class="reel-counter__name">${escapeHtml(player.name)}</span>${livesMarkup(player.lives)}</div>
    <div class="reel-counter__cell reel-counter__timer ${urgent ? "reel-counter__timer--urgent" : ""}"><span class="slug">Chrono</span><strong data-timer>${timer}</strong></div>
  </div>`;
}

/* -----------------------------------------------------------------------------
   Suggestions
   -------------------------------------------------------------------------- */

export function suggestionsMarkup() {
  return state.suggestions.map((person, index) => {
    const credits = person.creditCount ?? person.films?.length ?? 0;
    // Volontairement discret : les films de l'acteur ne doivent pas se voir avant validation, sous peine
    // de souffler la réponse à qui tape juste un nom.
    const details = `${roleLabel(person)} · ${credits} crédit${credits > 1 ? "s" : ""}`;
    const source = String(person.origin ?? "").includes("tmdb") ? "TMDb" : "Local";
    return `<button type="button" role="option" id="actor-suggestion-${index}" tabindex="-1" data-suggestion-index="${index}" aria-selected="${state.selectedPerson?.id === person.id}">${pictureMarkup(person.profilePath, person.name, "suggestion-portrait", "suggestion-avatar")}<span><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(details)}</small></span><em>${source}</em></button>`;
  }).join("");
}

function suggestionHint() {
  if (state.selectedPerson) return `${state.selectedPerson.name} sélectionné · ${String(state.selectedPerson.origin ?? "").includes("tmdb") ? "filmographie enrichie à la validation" : "snapshot local"}.`;
  if (!state.input.trim()) return `Snapshot ${app.database.snapshotId ?? "local"} · disponible hors connexion.`;
  if (state.searchStatus === "loading") return "Recherche locale terminée · interrogation du catalogue étendu…";
  // What matters when nothing matches is that the name remains playable — that has to come before any note about
  // where the catalogue lives.
  if (!state.suggestions.length) return "Artiste hors base — validez quand même, le groupe pourra l’accepter par vote.";
  if (state.catalogStatus.online === false) return "Hors connexion · résultats du snapshot et du cache local.";
  if (state.catalogStatus.configured === false) return "Catalogue local actif · ajoutez TMDB_API_TOKEN au serveur pour la recherche étendue.";
  return `${state.suggestions.length} proposition${state.suggestions.length > 1 ? "s" : ""} · choisissez la bonne identité.`;
}

export function renderSuggestions() {
  const container = document.querySelector("#actor-suggestions");
  if (container) container.innerHTML = suggestionsMarkup();
  const hint = document.querySelector(".input-hint");
  if (hint) {
    hint.textContent = suggestionHint();
    hint.classList.remove("input-hint--error");
  }
  document.querySelector("#actor-input")?.setAttribute("aria-expanded", String(state.suggestions.length > 0));
  const submit = document.querySelector("[data-submit-actor]");
  if (!submit) return;
  submit.disabled = !state.input.trim();
  // Naming the choice on the button removes the last doubt about what a second tap commits.
  submit.firstChild.textContent = state.selectedPerson ? `Valider ${state.selectedPerson.name} ` : "Valider ";
  submit.classList.toggle("button--armed", Boolean(state.selectedPerson));
}

function scheduleCatalogSearch(query) {
  stopSearch();
  const requested = String(query).trim();
  if (normalizeText(requested).length < 2) return;
  state.searchTimer = window.setTimeout(async () => {
    state.searchTimer = null;
    const controller = new AbortController();
    state.searchAbort = controller;
    try {
      const result = await app.catalog.search(requested, {
        themeId: state.game.config.themeId,
        excluded: state.game.chain,
        limit: 8,
        signal: controller.signal,
      });
      if (normalizeText(state.input) !== normalizeText(requested)) return;
      state.suggestions = result.results;
      state.catalogStatus = result.remote;
      state.searchStatus = "done";
      renderSuggestions();
    } catch (error) {
      if (error.name !== "AbortError") {
        state.searchStatus = "error";
        state.catalogStatus = { ...app.catalog.getState(), online: false };
        renderSuggestions();
      }
    } finally {
      if (state.searchAbort === controller) state.searchAbort = null;
    }
  }, 220);
}

/* -----------------------------------------------------------------------------
   Screens
   -------------------------------------------------------------------------- */

/* -----------------------------------------------------------------------------
   Ce que le verdict va coûter
   -------------------------------------------------------------------------- */

// Le classique ne disait rien des éliminations : le joueur sorti cessait simplement de recevoir le téléphone,
// sans un mot, et la table le croyait perdu quelque part dans l'ordre de passage. La résolution est pure — elle
// cloné la partie plutôt que de la modifier — donc l'écran de verdict peut la jouer d'avance et annoncer ce
// qu'un « Continuer » va coûter, à la place de le découvrir après coup.
function pendingConsequence() {
  if (!state.pending || state.phase !== "reveal") return null;
  let after;
  try {
    after = resolvePending(state.game, state.pending, { challenged: state.revealChallenged });
  } catch {
    return null;
  }
  const livesBefore = new Map(state.game.players.map((player) => [player.id, player.lives]));
  const struck = after.players.find((player) => player.lives < (livesBefore.get(player.id) ?? player.lives));
  if (!struck) return null;
  return { name: struck.name, lives: struck.lives, out: struck.lives === 0, last: after.status === "finished" };
}

function consequenceMarkup(consequence) {
  if (!consequence) return "";
  if (!consequence.out) {
    return `<p class="reveal-strike"><b>${escapeHtml(consequence.name)}</b> perd une vie · ${consequence.lives} restante${consequence.lives > 1 ? "s" : ""}</p>`;
  }
  return `<p class="reveal-strike reveal-strike--out" role="status"><span class="death-card" aria-hidden="true">FIN</span><b>${escapeHtml(consequence.name)}</b> est éliminé${consequence.last ? " · la partie s’arrête là" : " · sorti de la partie"}</p>`;
}

// Une partie élargie ne se joue pas comme une autre, et la preuve affichée doit pouvoir se relire à la lumière de
// la règle qui l'a acceptée. La ligne ne paraît que lorsqu'une extension est ouverte : au socle, il n'y a rien à
// dire — un film est un film.
function scopeNote() {
  const opened = describeExtensions(state.game?.config?.extensions);
  if (!opened.length) return "";
  return `<p class="reveal-note">Périmètre élargi · ${escapeHtml(opened.join(" · ").toLocaleLowerCase("fr"))}</p>`;
}

export function playMarkup() {
  const game = state.game;
  if (game.config.mode === "voice") return voiceMarkup();

  const player = currentPlayer(game);
  const previous = game.chain.at(-1);

  if (state.phase === "input") {
    // The clap is consumed by the render it decorates.
    const fresh = Boolean(state.handoff);
    state.handoff = null;
    if (!state.suggestions.length && state.input && !state.selectedPerson) {
      state.suggestions = app.database.searchPeople(state.input, { themeId: game.config.themeId, excluded: game.chain, limit: 8 });
    }
    return shell(`<section class="screen play">
      ${reelCounter({ fresh })}
      <div class="stub stub--kraft cue">
        <span class="slug">${previous ? "Acteur précédent" : "Acteur de départ"}</span>
        <div class="cue__actor">${previous ? portraitMarkup({ name: previous }) : ""}<span class="cue__name">${escapeHtml(previous || "À toi d’ouvrir la bobine")}</span></div>
      </div>
      <div>
        <label class="field-label slug" for="actor-input">Ton artiste</label>
        <input id="actor-input" class="field field--actor" value="${escapeHtml(state.input)}" placeholder="Nom de l’artiste…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${state.suggestions.length > 0}" aria-controls="actor-suggestions" autofocus>
      </div>
      <p class="input-hint" aria-live="polite">${suggestionHint()}</p>
      <div id="actor-suggestions" class="suggestions" role="listbox" aria-label="Artistes proposés">${suggestionsMarkup()}</div>
      <div class="screen__foot">
        <button class="button button--gold button--wide" data-submit-actor ${!state.input.trim() ? "disabled" : ""}>Valider <span aria-hidden="true">→</span></button>
      </div>
    </section>`, { back: "/" });
  }

  if (state.phase === "challenge" && state.pending) {
    const challenger = game.players.find((candidate) => candidate.id === state.pending.challengerId);
    return shell(`<section class="screen play play--center">
      <span class="stamp stamp--ambre">${escapeHtml(player.name)} propose</span>
      <div class="screen__spacer screen__spacer--half"></div>
      ${connectionMarkup(previous, state.pending.proposedActor, "— relié à —")}
      <p class="prose"><b>${escapeHtml(challenger?.name || "Le joueur suivant")}</b>, à toi de décider.</p>
      <div class="screen__spacer"></div>
      <div class="screen__foot">
        <div class="decision-grid">
          <button class="button button--ghost" data-pass-challenge>Laisser passer</button>
          <button class="button button--red" data-call-bluff>Bluff !</button>
        </div>
      </div>
    </section>`, { back: "/" });
  }

  if (state.phase === "verifying" && state.pending) {
    return shell(`<section class="screen play archive-check" aria-busy="true">
      <div class="screen__spacer"></div>
      <div class="archive-reel" aria-hidden="true">CF</div>
      <h1 class="marquee">Consultation<br>des archives</h1>
      <p class="prose">TMDb, Wikidata et Wikipédia cherchent une preuve positive. Une absence ne sera jamais transformée en verdict automatique.</p>
      <div class="screen__spacer"></div>
    </section>`, { back: "/" });
  }

  if (state.phase === "var" && state.pending) {
    return shell(`<section class="screen play">
      <span class="stamp stamp--rouge">Video Assistant Réalisateur</span>
      <h1 class="marquee">La VAR vous rend la décision</h1>
      ${connectionMarkup(previous, state.pending.proposedActor)}
      ${verificationPanelMarkup(state.pending.verification)}
      <div class="screen__spacer"></div>
      <div class="screen__foot">
        <div class="decision-grid decision-grid--var">
          <button class="button button--gold" data-var-valid>Le lien est valide</button>
          <button class="button button--red" data-var-invalid>Bluff confirmé</button>
          <button class="button button--ghost" data-var-pass>Laisser passer sans trancher</button>
        </div>
      </div>
    </section>`, { back: "/" });
  }

  const consequence = pendingConsequence();
  const valid = Boolean(state.pending?.wasValid);
  const films = valid && state.pending.sharedFilms.length
    ? `<div class="stub film-proof"><span class="slug slug--ambre">Film${state.pending.sharedFilms.length > 1 ? "s" : ""} commun${state.pending.sharedFilms.length > 1 ? "s" : ""}</span><ul>${state.pending.sharedFilms.map((film) => `<li>${escapeHtml(film)}</li>`).join("")}</ul></div>`
    : "";
  const provenance = state.pending?.verification?.source && state.pending.verification.source !== "none"
    ? `<p class="reveal-note">Preuve issue de ${escapeHtml(verificationSourceLabel(state.pending.verification.source))}${state.pending.manualDecision ? ", décision finale des joueurs" : ""}.</p>`
    : state.pending?.manualDecision ? `<p class="reveal-note">Décision finale rendue manuellement par les joueurs.</p>` : "";
  return shell(`<section class="screen play play--center">
    <span class="stamp verdict ${valid ? "stamp--vert verdict--valid" : "stamp--rouge verdict--invalid"}">${valid ? "Valide" : "Invalide"}</span>
    <div class="screen__spacer screen__spacer--half"></div>
    ${connectionMarkup(previous, state.pending?.proposedActor)}
    ${films}
    ${state.revealChallenged ? `<p class="reveal-note">Bluff annoncé — ${valid ? "ce n’était pas un bluff." : "c’était bien un bluff."}</p>` : ""}
    ${state.pending?.autoVerify ? `<p class="reveal-note">Défis de bluff coupés — la liaison est vérifiée automatiquement entre chaque acteur.</p>` : ""}
    ${scopeNote()}
    ${state.pending?.verification ? verificationCascadeMarkup(state.pending.verification) : ""}
    ${provenance}
    ${state.pending?.method === "timeout" ? `<p class="reveal-note">Le chrono a mangé la réplique.</p>` : ""}
    ${consequenceMarkup(consequence)}
    <div class="screen__spacer"></div>
    <div class="screen__foot">
      <button class="button button--gold button--wide" data-continue>Continuer <span aria-hidden="true">→</span></button>
    </div>
  </section>`, { back: "/" });
}

/* -----------------------------------------------------------------------------
   Bindings
   -------------------------------------------------------------------------- */

export function bindPlay() {
  if (state.game.config.mode === "voice") {
    bindVoice();
    return;
  }

  const actorInput = document.querySelector("#actor-input");
  if (actorInput) {
    actorInput.addEventListener("input", (event) => {
      state.input = event.target.value;
      state.selectedPerson = null;
      state.suggestions = app.database.searchPeople(state.input, { themeId: state.game.config.themeId, excluded: state.game.chain, limit: 8 });
      state.searchStatus = state.input.trim().length >= 2 ? "loading" : "idle";
      renderSuggestions();
      scheduleCatalogSearch(state.input);
    });
    actorInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitActor();
      if (event.key === "Escape" && state.suggestions.length) {
        state.suggestions = [];
        renderSuggestions();
      }
    });
  }

  document.querySelector("#actor-suggestions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggestion-index]");
    if (!button) return;
    const person = state.suggestions[Number(button.dataset.suggestionIndex)];
    if (!person) return;
    stopSearch();
    state.selectedPerson = person;
    state.input = person.name;
    actorInput.value = person.name;
    // Closing the list is what brings the button back above the fold, and moving focus off the field also
    // dismisses the phone keyboard.
    state.suggestions = [];
    renderSuggestions();
    document.querySelector("[data-submit-actor]")?.focus({ preventScroll: false });
  });

  document.querySelector("[data-submit-actor]")?.addEventListener("click", submitActor);
  document.querySelector("[data-pass-challenge]")?.addEventListener("click", () => {
    commitResolved(resolvePending(state.game, state.pending, { challenged: false }));
  });
  document.querySelector("[data-call-bluff]")?.addEventListener("click", callBluff);
  document.querySelector("[data-var-valid]")?.addEventListener("click", () => revealVarDecision(true));
  document.querySelector("[data-var-invalid]")?.addEventListener("click", () => revealVarDecision(false));
  document.querySelector("[data-var-pass]")?.addEventListener("click", passVarDecision);
  document.querySelector("[data-continue]")?.addEventListener("click", () => {
    commitResolved(resolvePending(state.game, state.pending, { challenged: state.revealChallenged }));
  });

  if (state.phase === "input") ensureTimer();
}

async function callBluff() {
  if (!state.pending || state.verificationStatus === "loading") return;
  state.revealChallenged = true;
  if (state.pending.wasValid) {
    state.phase = "reveal";
    renderRoute();
    return;
  }
  state.verificationStatus = "loading";
  state.phase = "verifying";
  renderRoute();
  try {
    state.pending = await verifyPendingLink(state.game, state.pending);
    state.phase = state.pending.wasValid ? "reveal" : "var";
  } catch (error) {
    app.diagnostics.capture(error, { phase: "verify-link" });
    state.pending = applyLinkVerification(state.pending, { verdict: "UNKNOWN", source: "none", films: [], evidence: [], searchLinks: {} });
    state.phase = "var";
  } finally {
    state.verificationStatus = "idle";
    renderRoute();
  }
}

// Le mode sans défi de bluff : entre chaque acteur, on vérifie la liaison sans attendre qu'un joueur la conteste.
// Une preuve positive (catalogue local ou cascade) valide le coup en silence ; à défaut, la table tranche via la
// VAR — jamais un verdict négatif automatique, fidèle au principe « une absence n'est pas une preuve ».
async function runAutoVerification() {
  if (!state.pending) return;
  if (state.pending.wasValid) {
    // Le catalogue local atteste déjà la paire : on l'accepte comme un coup non contesté, sans écran.
    commitResolved(resolvePending(state.game, state.pending, { challenged: false }));
    return;
  }
  state.verificationStatus = "loading";
  state.phase = "verifying";
  renderRoute();
  try {
    state.pending = await verifyPendingLink(state.game, state.pending);
  } catch (error) {
    app.diagnostics.capture(error, { phase: "auto-verify-link" });
    state.pending = applyLinkVerification(state.pending, { verdict: "UNKNOWN", source: "none", films: [], evidence: [], searchLinks: {} });
  } finally {
    state.verificationStatus = "idle";
  }
  if (state.pending.wasValid) {
    // La cascade a trouvé une preuve : on valide automatiquement, sans déranger la table.
    commitResolved(resolvePending(state.game, state.pending, { challenged: false }));
  } else {
    // Rien n'a pu être prouvé : on rend la décision aux joueurs plutôt que d'inventer une liaison absente.
    state.phase = "var";
    renderRoute();
  }
}

function passVarDecision() {
  if (!state.pending) return;
  // « Laisser passer sans trancher » est un choix positif d'accepter faute de preuve — jamais une rupture de chaîne
  // silencieuse. En mode auto-vérifié, le coup ne s'accepte qu'à travers un verdict « valide » : on l'y porte
  // explicitement, sans preuve filmographique, plutôt que de le laisser tomber.
  const pending = state.pending.autoVerify
    ? adjudicatePending(state.pending, { valid: true, source: "let-pass" })
    : state.pending;
  commitResolved(resolvePending(state.game, pending, { challenged: false }));
}

function revealVarDecision(valid) {
  if (!state.pending) return;
  state.pending = adjudicatePending(state.pending, { valid });
  // En mode sans défi, il n'y a pas eu de bluff annoncé : la révélation ne doit ni afficher « bluff annoncé » ni
  // rejouer le barème du défi lorsqu'on tranchera.
  state.revealChallenged = !state.pending.autoVerify;
  state.phase = "reveal";
  renderRoute();
}

async function submitActor() {
  // The button disables itself, but Enter bypasses the button entirely, and hydration holds the door open for a
  // whole network round trip — long enough to send the same artist twice.
  if (state.submitting || !state.input.trim()) return;
  state.submitting = true;
  stopSearch();
  const button = document.querySelector("[data-submit-actor]");
  if (button) {
    button.disabled = true;
    button.firstChild.textContent = "Vérification… ";
  }
  // Committing a turn is a network round trip, and a turn that resolves on its own repaints the very same screen
  // afterwards. Without locking the field, anything typed during that gap would be wiped by the repaint with no
  // sign that it had ever been taken — so the field states plainly that it is busy.
  const field = document.querySelector("#actor-input");
  if (field) field.disabled = true;
  try {
    let person = state.selectedPerson;
    if (!person || normalizeText(person.name) !== normalizeText(state.input)) {
      person = app.database.findActor(state.input, state.game.config.themeId);
    }
    if (person) {
      try {
        person = await app.catalog.hydrate(person) ?? person;
        setCatalogStatus(app.catalog.getState());
      } catch {
        setCatalogStatus({ ...app.catalog.getState(), online: false });
      }
    }
    const result = proposeActor(state.game, person?.name ?? state.input, app.database);
    state.input = "";
    state.suggestions = [];
    state.selectedPerson = null;
    if (result.type === "pending") {
      state.pending = result.pending;
      stopTimer();
      if (result.pending.autoVerify) {
        // Pas de défi de bluff : aucun joueur ne va lever la main, c'est donc au jeu de vérifier la liaison avant
        // que la chaîne ne s'allonge.
        await runAutoVerification();
      } else {
        state.phase = "challenge";
        renderRoute();
      }
    } else commitResolved(result.game);
  } catch (error) {
    const hint = document.querySelector(".input-hint");
    if (hint) {
      hint.textContent = error.message;
      hint.classList.add("input-hint--error");
    }
    if (button) {
      button.disabled = false;
      // Without this the button keeps reading "Vérification…" for the rest of the turn.
      button.firstChild.textContent = state.selectedPerson ? `Valider ${state.selectedPerson.name} ` : "Valider ";
    }
    if (field) {
      field.disabled = false;
      field.focus();
    }
  } finally {
    state.submitting = false;
  }
}

function commitResolved(game) {
  stopTimer();
  state.game = game;
  state.pending = null;
  state.revealChallenged = false;
  state.verificationStatus = "idle";
  state.input = "";
  state.timeLeft = null;
  app.storage.saveCurrent(game);
  // The roll is assembled between turns, on idle time, so the last life never costs the table a wait.
  queueCreditsRefresh(game);
  if (game.status === "finished") {
    archiveFinishedGame(game);
    navigate("/credits");
  }
  else {
    // Straight back to the field the next player needs, with the counter clapping their name into place.
    state.phase = "input";
    state.handoff = currentPlayer(game).name;
    renderRoute();
  }
}

function ensureTimer() {
  if (state.timer || !state.game.config.turnSeconds || state.phase !== "input") return;
  if (state.timeLeft === null) state.timeLeft = state.game.config.turnSeconds;
  state.timer = window.setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      stopTimer();
      state.pending = timeoutPending(state.game);
      state.phase = "reveal";
      state.revealChallenged = false;
      renderRoute();
      return;
    }
    const timer = document.querySelector("[data-timer]");
    if (timer) {
      timer.textContent = `${state.timeLeft}s`;
      timer.parentElement.classList.toggle("reel-counter__timer--urgent", state.timeLeft <= 5);
    }
  }, 1000);
}
