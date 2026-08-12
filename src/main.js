import { createDatabase } from "./game/database.js";
import {
  alivePlayers,
  createGame,
  currentPlayer,
  proposeActor,
  resolvePending,
  timeoutPending,
} from "./game/engine.js";
import { ACHIEVEMENTS, levelForXp } from "./game/achievements.js";
import { createStorage, recordFinishedGame } from "./game/storage.js";

const root = document.querySelector("#app");
const storage = createStorage();
const BASE_PATH = new URL(".", import.meta.url).pathname.replace(/\/src\/?$/, "");
const data = await fetch(new URL("./data/cinema-database.json", import.meta.url)).then((response) => response.json());
const database = createDatabase(data);

const state = {
  game: storage.loadCurrent(),
  setup: null,
  phase: "pass",
  pending: null,
  revealChallenged: false,
  input: "",
  timeLeft: null,
  timer: null,
  newAchievements: [],
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const html = (strings, ...values) => strings.reduce((result, string, index) => `${result}${string}${values[index] ?? ""}`, "");
const href = (target) => `${BASE_PATH}${target}`;
const path = () => {
  const pathname = window.location.pathname;
  const relative = BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname;
  return relative.replace(/\/$/, "") || "/";
};

function livesMarkup(lives, large = false) {
  const count = Math.max(1, lives);
  return `<span class="lives ${large ? "lives--large" : ""}" aria-label="${lives} vie${lives > 1 ? "s" : ""}">${Array.from({ length: count }, (_, index) => `<span class="heart ${index < lives ? "heart--on" : "heart--off"}">♥</span>`).join("")}</span>`;
}

function brandMarkup(compact = false) {
  return `<a class="brand ${compact ? "brand--compact" : ""}" href="${href("/")}" data-nav><span class="brand__seal">✦</span><span class="brand__words"><b>CINÉ</b><em>FIL</em></span></a>`;
}

function shell(content, { back = null, eyebrow = "Ciné-Fil Pictures" } = {}) {
  return `<main class="page"><div class="film-grain" aria-hidden="true"></div><header class="topbar">${back ? `<a class="back-link" href="${href(back)}" data-nav>← ${back === "/" ? "Accueil" : "Retour"}</a>` : "<span></span>"}${brandMarkup(true)}<span class="topbar__eyebrow">${eyebrow}</span></header><div class="page__body">${content}</div></main>`;
}

function navigate(target) {
  stopTimer();
  history.pushState({}, "", href(target));
  state.phase = "pass";
  state.pending = null;
  state.revealChallenged = false;
  state.input = "";
  state.timeLeft = null;
  renderRoute();
}

function renderHome() {
  const hasGame = state.game?.status === "in-progress";
  root.innerHTML = `<main class="hero"><div class="hero__backdrop" aria-hidden="true"></div><div class="film-grain" aria-hidden="true"></div><div class="hero__content"><div class="studio-stamp">${brandMarkup()}</div><p class="kicker">Un jeu de culture cinéma · deux à dix joueurs</p><h1>Le dernier<br><span>à l’écran.</span></h1><p class="hero__intro">Reliez chaque acteur au précédent par un film commun. Bluffez, démasquez, survivez : la culture ciné décide du dernier debout.</p><div class="hero__actions"><a class="button button--gold" href="${href("/setup")}" data-nav>Nouvelle partie <span>→</span></a>${hasGame ? `<a class="button button--ghost" href="${href("/play")}" data-nav>Reprendre la partie <span>↗</span></a>` : ""}<a class="button button--text" href="${href("/profiles")}" data-nav>Profils &amp; succès</a></div><p class="hero__fineprint">Sans compte · sans connexion · sauvegardé sur cet appareil</p></div><div class="hero__credits">CINÉFIL PICTURES · PRÉSENTE</div></main>`;
}

function setupMarkup() {
  const setup = state.setup ?? { names: ["", ""], themeId: "classic", livesPerPlayer: 3, turnSeconds: 30, allowBluffChallenge: true };
  state.setup = setup;
  const names = setup.names.map((name, index) => `<div class="player-row"><span class="player-number">${String(index + 1).padStart(2, "0")}</span><input class="field" data-player-index="${index}" value="${escapeHtml(name)}" placeholder="Nom du joueur ${index + 1}" maxlength="24" autocomplete="off">${setup.names.length > 2 ? `<button class="icon-button" data-remove-player="${index}" aria-label="Retirer ${escapeHtml(name || `le joueur ${index + 1}`)}">×</button>` : ""}</div>`).join("");
  return shell(`<section class="form-page"><div class="section-heading"><p class="kicker">Pré-production</p><h1>Nouvelle partie</h1><p>Installez-vous. Un seul écran, plusieurs joueurs, zéro compte.</p></div><section class="panel panel--paper"><div class="panel__title"><span class="panel__number">01</span><div><h2>Le casting</h2><p>Ajoutez les personnes autour de la table.</p></div></div><div class="players-list">${names}</div><button class="add-player" data-add-player ${setup.names.length >= 10 ? "disabled" : ""}>＋ Ajouter un joueur</button></section><section class="panel"><div class="panel__title"><span class="panel__number">02</span><div><h2>Le décor</h2><p>Choisissez votre terrain de jeu.</p></div></div><div class="theme-grid"><button class="theme-card ${setup.themeId === "classic" ? "theme-card--selected" : ""}" data-theme="classic"><span class="theme-card__icon">◎</span><b>Classique</b><small>Tous les acteurs, tous les films</small></button><button class="theme-card ${setup.themeId === "fr" ? "theme-card--selected" : ""}" data-theme="fr"><span class="theme-card__icon">✦</span><b>French Touch</b><small>Les comédies et classiques français</small></button></div></section><section class="panel"><div class="panel__title"><span class="panel__number">03</span><div><h2>Les règles</h2><p>Un peu de tension ne fait jamais de mal.</p></div></div><div class="range-setting"><label for="lives-range"><span>Vies par joueur</span><strong id="lives-value">${setup.livesPerPlayer}</strong></label><input id="lives-range" type="range" min="1" max="5" value="${setup.livesPerPlayer}"></div><div class="range-setting"><label for="timer-range"><span>Chrono par tour</span><strong id="timer-value">${setup.turnSeconds === 0 ? "∞" : `${setup.turnSeconds}s`}</strong></label><input id="timer-range" type="range" min="0" max="60" step="5" value="${setup.turnSeconds}" ${setup.turnSeconds === 0 ? "disabled" : ""}><label class="check-row"><input id="no-timer" type="checkbox" ${setup.turnSeconds === 0 ? "checked" : ""}><span>Jouer sans chrono</span></label></div><label class="check-row"><input id="allow-bluff" type="checkbox" ${setup.allowBluffChallenge ? "checked" : ""}><span>Autoriser les défis de bluff</span></label></section><button class="button button--gold button--wide" data-start-game>Lancer la partie <span>→</span></button><p class="form-note">Il faut au moins deux noms pour tourner la première bobine.</p></section>`, { back: "/", eyebrow: "Casting call" });
}

function bindSetup() {
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
  document.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
    state.setup.themeId = button.dataset.theme;
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
    if (names.length < 2) return;
    state.game = createGame({ names, config: state.setup });
    storage.saveCurrent(state.game);
    navigate("/play");
  });
  updateSetupButton();
}

function updateSetupButton() {
  const button = document.querySelector("[data-start-game]");
  if (button) button.disabled = state.setup.names.filter((name) => name.trim()).length < 2;
}

function gameHeader() {
  const player = currentPlayer(state.game);
  const timer = state.timeLeft === null ? (state.game.config.turnSeconds ? `${state.game.config.turnSeconds}s` : "∞") : `${state.timeLeft}s`;
  return `<div class="game-status"><div><small>Chaîne</small><strong>${state.game.chain.length}</strong></div><div class="game-status__player"><small>À vous, ${escapeHtml(player.name)}</small>${livesMarkup(player.lives)}</div><div class="game-status__timer ${state.timeLeft !== null && state.timeLeft <= 5 ? "game-status__timer--urgent" : ""}"><small>Temps</small><strong data-timer>${timer}</strong></div></div>`;
}

function playMarkup() {
  const game = state.game;
  const player = currentPlayer(game);
  const previous = game.chain.at(-1);
  if (state.phase === "pass") {
    return shell(`<section class="play-page play-page--center"><p class="kicker">Passez l’écran à</p><h1 class="player-call">${escapeHtml(player.name)}</h1><div class="player-lives">${livesMarkup(player.lives, true)}</div><div class="scene-card"><small>${previous ? "Acteur précédent" : "C’est toi qui démarres"}</small><strong>${escapeHtml(previous || "Choisis l’acteur de départ")}</strong></div><button class="button button--gold button--wide" data-ready>Je suis prêt <span>→</span></button></section>`, { back: "/", eyebrow: "One screen · many players" });
  }
  if (state.phase === "input") {
    const suggestions = database.searchActors(state.input, { themeId: game.config.themeId, excluded: game.chain, limit: 6 });
    return shell(`<section class="play-page"><div class="play-page__top">${gameHeader()}</div><div class="prompt-card"><small>${previous ? "Relie cet acteur à" : "Acteur de départ"}</small><h1>${escapeHtml(previous || "À toi de lancer la partie")}</h1></div><label class="field-label" for="actor-input">Ton acteur</label><input id="actor-input" class="field field--actor" value="${escapeHtml(state.input)}" placeholder="Nom de l’acteur…" autocomplete="off" autofocus><div class="suggestions">${suggestions.map((suggestion) => `<button data-suggestion="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>`).join("")}</div><p class="input-hint">${state.input && !database.hasActor(state.input, game.config.themeId) ? "Acteur hors base — le groupe pourra voter." : "Tape quelques lettres pour afficher les suggestions."}</p><button class="button button--gold button--wide" data-submit-actor ${!state.input.trim() ? "disabled" : ""}>Valider <span>→</span></button></section>`, { back: "/", eyebrow: "The chain" });
  }
  if (state.phase === "challenge" && state.pending) {
    const challenger = game.players.find((candidate) => candidate.id === state.pending.challengerId);
    return shell(`<section class="play-page play-page--center"><p class="kicker">${escapeHtml(player.name)} propose</p><h1 class="actor-reveal">${escapeHtml(state.pending.proposedActor)}</h1><p class="reveal-subtitle">pour relier à <b>${escapeHtml(previous)}</b></p><div class="scene-card scene-card--decision"><p><b>${escapeHtml(challenger?.name || "Le joueur suivant")}</b>, à toi de décider.</p><ul><li>Laisser passer : le coup est accepté.</li><li>Bluff : on vérifie dans la filmographie.</li></ul></div><div class="decision-grid"><button class="button button--ghost" data-pass-challenge>Laisser passer</button><button class="button button--red" data-call-bluff>Bluff !</button></div></section>`, { back: "/", eyebrow: "The courtroom" });
  }
  const valid = Boolean(state.pending?.wasValid);
  return shell(`<section class="play-page play-page--center"><span class="verdict ${valid ? "verdict--valid" : "verdict--invalid"}">${valid ? "Valide" : "Invalide"}</span><h1 class="connection">${escapeHtml(previous)} <span>↔</span> <em>${escapeHtml(state.pending?.proposedActor)}</em></h1>${valid && state.pending.sharedFilms.length ? `<div class="film-proof"><small>Film${state.pending.sharedFilms.length > 1 ? "s" : ""} commun${state.pending.sharedFilms.length > 1 ? "s" : ""}</small><ul>${state.pending.sharedFilms.map((film) => `<li>${escapeHtml(film)}</li>`).join("")}</ul></div>` : ""}${state.revealChallenged ? `<p class="reveal-note">Bluff annoncé — ${valid ? "ce n’était pas un bluff." : "c’était bien un bluff."}</p>` : ""}${state.pending?.method === "timeout" ? `<p class="reveal-note">Le chrono a mangé la réplique.</p>` : ""}<button class="button button--gold button--wide" data-continue>Continuer <span>→</span></button></section>`, { back: "/", eyebrow: "The verdict" });
}

function bindPlay() {
  document.querySelector("[data-ready]")?.addEventListener("click", () => {
    state.phase = "input";
    state.input = "";
    state.timeLeft = null;
    renderRoute();
  });
  const actorInput = document.querySelector("#actor-input");
  if (actorInput) {
    actorInput.addEventListener("input", (event) => {
      state.input = event.target.value;
      renderRoute();
      const next = document.querySelector("#actor-input");
      next?.focus();
      next?.setSelectionRange(state.input.length, state.input.length);
    });
    actorInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitActor();
    });
  }
  document.querySelectorAll("[data-suggestion]").forEach((button) => button.addEventListener("click", () => {
    state.input = button.dataset.suggestion;
    renderRoute();
    document.querySelector("#actor-input")?.focus();
  }));
  document.querySelector("[data-submit-actor]")?.addEventListener("click", submitActor);
  document.querySelector("[data-pass-challenge]")?.addEventListener("click", () => {
    commitResolved(resolvePending(state.game, state.pending, { challenged: false }));
  });
  document.querySelector("[data-call-bluff]")?.addEventListener("click", () => {
    state.revealChallenged = true;
    state.phase = "reveal";
    renderRoute();
  });
  document.querySelector("[data-continue]")?.addEventListener("click", () => {
    commitResolved(resolvePending(state.game, state.pending, { challenged: state.revealChallenged }));
  });
  if (state.phase === "input") ensureTimer();
}

function submitActor() {
  if (!state.input.trim()) return;
  try {
    const result = proposeActor(state.game, state.input, database);
    state.input = "";
    if (result.type === "pending") {
      state.pending = result.pending;
      state.phase = "challenge";
      stopTimer();
      renderRoute();
    } else commitResolved(result.game);
  } catch (error) {
    const hint = document.querySelector(".input-hint");
    if (hint) {
      hint.textContent = error.message;
      hint.classList.add("input-hint--error");
    }
  }
}

function commitResolved(game) {
  stopTimer();
  state.game = game;
  state.pending = null;
  state.revealChallenged = false;
  state.input = "";
  state.timeLeft = null;
  storage.saveCurrent(game);
  if (game.status === "finished") navigate("/results");
  else {
    state.phase = "pass";
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
      timer.parentElement.classList.toggle("game-status__timer--urgent", state.timeLeft <= 5);
    }
  }, 1000);
}

function stopTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
}

function renderResults() {
  const game = state.game ?? storage.loadCurrent();
  if (!game || game.status !== "finished") {
    root.innerHTML = shell(`<section class="empty-state"><p class="kicker">Salle vide</p><h1>Aucune partie terminée.</h1><a class="button button--gold" href="${href("/setup")}" data-nav>Tourner une partie</a></section>`, { back: "/" });
    return;
  }
  state.game = game;
  const result = recordFinishedGame(game, storage);
  state.newAchievements = result.newAchievements;
  const ordered = [...game.players].sort((left, right) => (right.id === game.winnerId) - (left.id === game.winnerId) || right.score - left.score);
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = state.newAchievements.map((id) => ACHIEVEMENTS.find((achievement) => achievement.id === id)).filter(Boolean);
  root.innerHTML = shell(`<section class="results-page"><div class="credits-card"><p class="kicker">Ciné-Fil Pictures présente</p><small>Dans le rôle du vainqueur</small><h1>${escapeHtml(winner?.name ?? "Personne")}</h1><p>Une chaîne de ${game.chain.length} acteurs</p><div class="credits-card__line"></div><small>Réalisé par</small><b>Vous tous</b></div><section class="panel panel--ranking"><div class="panel__title"><span class="panel__number">01</span><div><h2>Le classement</h2><p>Le générique défile, les scores restent.</p></div></div><ol class="ranking">${ordered.map((player, index) => `<li class="ranking__row ${player.id === game.winnerId ? "ranking__row--winner" : ""}"><span class="ranking__place">#${index + 1}</span><strong>${escapeHtml(player.name)}</strong><span>${player.filmsFound} films · ${player.score} pts · série ${player.bestStreak}</span></li>`).join("")}</ol></section>${newAchievements.length ? `<section class="panel"><div class="panel__title"><span class="panel__number">02</span><div><h2>Nouveau succès</h2><p>Une nouvelle ligne au palmarès.</p></div></div><div class="achievement-list">${newAchievements.map((achievement) => `<div class="achievement"><span>${achievement.icon}</span><div><b>${achievement.label}</b><small>${achievement.description}</small></div></div>`).join("")}</div></section>` : ""}<section class="panel"><div class="panel__title"><span class="panel__number">03</span><div><h2>Chaîne complète</h2><p>La bobine entière, sans coupure.</p></div></div><p class="chain-line">${game.chain.map((actor, index) => `<span>${escapeHtml(actor)}</span>${index < game.chain.length - 1 ? " <b>→</b> " : ""}`).join("")}</p></section><div class="results-actions"><button class="button button--gold" data-replay>Rejouer <span>↗</span></button><a class="button button--ghost" href="${href("/")}" data-nav>Accueil</a></div></section>`, { back: "/", eyebrow: "End credits" });
  document.querySelector("[data-replay]")?.addEventListener("click", () => {
    const names = game.players.map((player) => player.name);
    state.game = createGame({ names, config: game.config });
    storage.saveCurrent(state.game);
    navigate("/play");
  });
}

function renderProfiles() {
  const profiles = Object.values(storage.loadProfiles()).sort((left, right) => right.wins - left.wins || right.xp - left.xp);
  root.innerHTML = shell(`<section class="profiles-page"><div class="section-heading"><p class="kicker">Archives du studio</p><h1>Profils</h1><p>Les statistiques cumulées de tous les joueurs sur cet appareil.</p></div>${profiles.length ? `<div class="profile-list">${profiles.map((profile) => `<article class="profile-card"><div class="profile-card__head"><div><h2>${escapeHtml(profile.name)}</h2><p>${levelForXp(profile.xp)} · ${profile.xp} XP</p></div><span>${profile.games} partie${profile.games > 1 ? "s" : ""}</span></div><div class="profile-stats"><div><b>${profile.wins}</b><small>Victoires</small></div><div><b>${profile.filmsFound}</b><small>Films</small></div><div><b>${profile.bluffsSucceeded}</b><small>Bluffs</small></div><div><b>${profile.bluffsCaught}</b><small>Démasqués</small></div></div>${profile.achievements?.length ? `<div class="profile-achievements">${profile.achievements.map((id) => { const achievement = ACHIEVEMENTS.find((item) => item.id === id); return achievement ? `<span title="${escapeHtml(achievement.description)}">${achievement.icon} ${escapeHtml(achievement.label)}</span>` : ""; }).join("")}</div>` : ""}</article>`).join("")}</div>` : `<div class="empty-state empty-state--panel"><p class="kicker">Pas encore de générique</p><h2>Aucun profil.</h2><p>Terminez une partie pour créer le premier.</p></div>`}<section class="panel all-achievements"><div class="panel__title"><span class="panel__number">∞</span><div><h2>Tous les succès</h2><p>Les trophées qui attendent leur scène.</p></div></div><div class="achievement-grid">${ACHIEVEMENTS.map((achievement) => `<div class="achievement achievement--muted"><span>${achievement.icon}</span><div><b>${achievement.label}</b><small>${achievement.description}</small></div></div>`).join("")}</div></section></section>`, { back: "/", eyebrow: "Hall of fame" });
}

function renderRoute() {
  stopTimer();
  const currentPath = path();
  if (currentPath === "/setup") {
    root.innerHTML = setupMarkup();
    bindSetup();
    return;
  }
  if (currentPath === "/play") {
    state.game = storage.loadCurrent() ?? state.game;
    if (!state.game || state.game.status === "finished") {
      navigate(state.game?.status === "finished" ? "/results" : "/");
      return;
    }
    root.innerHTML = playMarkup();
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

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-nav]");
  if (!link) return;
  event.preventDefault();
  const rawHref = link.getAttribute("href");
  const target = BASE_PATH && rawHref.startsWith(BASE_PATH) ? rawHref.slice(BASE_PATH.length) || "/" : rawHref;
  navigate(target);
});
window.addEventListener("popstate", renderRoute);
renderRoute();
