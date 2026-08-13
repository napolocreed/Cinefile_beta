import { createDatabase, normalizeText } from "./game/database.js";
import { CATALOG_CACHE_KEY, createHybridCatalog } from "./game/catalog.js";
import { createStaticOverlay } from "./game/static-overlay.js";
import {
  alivePlayers,
  createGame,
  currentPlayer,
  proposeActor,
  replaceLastActor,
  resolvePending,
  timeoutPending,
} from "./game/engine.js";
import { ACHIEVEMENTS, levelForXp } from "./game/achievements.js";
import { createStorage, recordFinishedGame } from "./game/storage.js";
import { backupFilename, createBackup, parseBackup, restoreBackup } from "./game/transfer.js";
import { createDiagnostics } from "./game/diagnostics.js";
import { candidateConfidenceLabel, resolveVoiceTranscript } from "./voice/entity-resolver.js";
import { createSpeechSession, isSpeechRecognitionSupported } from "./voice/speech-session.js";

function normalizeBasePath(value) {
  const clean = `/${String(value ?? "/").trim().replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/" : `${clean}/`;
}

const APP_BASE = normalizeBasePath(document.querySelector('meta[name="app-base"]')?.content ?? "/");
const CATALOG_MODE = document.querySelector('meta[name="catalog-mode"]')?.content === "static" ? "static" : "remote";
const assetUrl = (value = "") => `${APP_BASE}${String(value).replace(/^\/+/, "")}`;
const routeUrl = (value = "/") => {
  const logical = `/${String(value).replace(/^\/+|\/+$/g, "")}`;
  return logical === "/" ? APP_BASE : assetUrl(logical);
};
const logicalPath = (pathname = window.location.pathname) => {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const baseWithoutSlash = APP_BASE.replace(/\/+$/, "") || "/";
  if (normalizedPathname === baseWithoutSlash) return "/";
  if (APP_BASE !== "/" && normalizedPathname.startsWith(APP_BASE)) return `/${normalizedPathname.slice(APP_BASE.length).replace(/^\/+|\/+$/g, "")}`;
  return normalizedPathname;
};

const root = document.querySelector("#app");
const storage = createStorage();
const diagnostics = createDiagnostics();
diagnostics.install(window);
document.documentElement.toggleAttribute("data-large-text", storage.loadSettings().largeText === true);
const overlayAsset = "src/data/tmdb-overlay-index.json";
const [data, synonyms, overlay] = await Promise.all([
  fetch(assetUrl("src/data/cinema-knowledge.json")).then((response) => response.ok ? response.json() : Promise.reject(new Error("snapshot"))).catch(() => fetch(assetUrl("src/data/cinema-database.json")).then((response) => response.json())),
  fetch(assetUrl("src/data/cinema-synonyms.json")).then((response) => response.json()).catch(() => ({ people: [], works: [] })),
  CATALOG_MODE === "static"
    ? fetch(assetUrl(overlayAsset)).then((response) => response.ok ? response.json() : Promise.reject(new Error("overlay"))).catch(() => ({ version: 1, people: [] }))
    : Promise.resolve({ version: 1, people: [] }),
]);
const database = createDatabase(data, { synonyms });
let staticOverlay = null;
if (CATALOG_MODE === "static") {
  staticOverlay = createStaticOverlay({ database, index: overlay, resolveAsset: assetUrl });
}
const catalog = createHybridCatalog({
  database,
  remoteEnabled: CATALOG_MODE === "remote",
  staticHydrate: staticOverlay?.hydrate,
});

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
  suggestions: [],
  selectedPerson: null,
  searchStatus: "idle",
  searchTimer: null,
  searchAbort: null,
  catalogStatus: catalog.getState(),
  voice: createVoiceState(),
  transferNotice: null,
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const html = (strings, ...values) => strings.reduce((result, string, index) => `${result}${string}${values[index] ?? ""}`, "");
const path = () => logicalPath();

function createVoiceState() {
  return {
    supported: isSpeechRecognitionSupported(window),
    session: null,
    consent: false,
    listening: false,
    processing: false,
    interim: "",
    error: null,
    entries: [],
    review: null,
    verdict: null,
  };
}

function livesMarkup(lives, large = false) {
  const count = Math.max(1, lives);
  return `<span class="lives ${large ? "lives--large" : ""}" aria-label="${lives} vie${lives > 1 ? "s" : ""}">${Array.from({ length: count }, (_, index) => `<span class="heart ${index < lives ? "heart--on" : "heart--off"}">♥</span>`).join("")}</span>`;
}

function brandMarkup(compact = false) {
  return `<a class="brand ${compact ? "brand--compact" : ""}" href="${routeUrl("/")}" data-nav><span class="brand__seal">✦</span><span class="brand__words"><b>CINÉ</b><em>FIL</em></span></a>`;
}

function shell(content, { back = null, eyebrow = "Ciné-Fil Pictures" } = {}) {
  const wide = String(content).includes("voice-page") || String(content).includes("voice-review");
  const routedContent = String(content).replace(/href="(\/[^"#?]*)"/g, (_, route) => `href="${APP_BASE !== "/" && route.startsWith(APP_BASE) ? route : routeUrl(route)}"`);
  return `<main class="page"><div class="film-grain" aria-hidden="true"></div><header class="topbar">${back ? `<a class="back-link" href="${routeUrl(back)}" data-nav>← ${back === "/" ? "Accueil" : "Retour"}</a>` : "<span></span>"}${brandMarkup(true)}<span class="topbar__eyebrow">${eyebrow}</span></header><div class="page__body ${wide ? "page__body--wide" : ""}">${routedContent}</div></main>`;
}

function navigate(target) {
  const destination = new URL(target, window.location.origin);
  const logicalTarget = logicalPath(destination.pathname);
  stopTimer();
  stopSearch();
  if (logicalTarget !== "/play" && state.voice?.session) stopVoiceSession();
  history.pushState({}, "", routeUrl(logicalTarget));
  state.phase = "pass";
  state.pending = null;
  state.revealChallenged = false;
  state.input = "";
  state.suggestions = [];
  state.selectedPerson = null;
  state.timeLeft = null;
  renderRoute();
  window.scrollTo(0, 0);
  root.focus({ preventScroll: true });
}

function renderHome() {
  const hasGame = state.game?.status === "in-progress";
  root.innerHTML = `<main class="hero"><div class="hero__backdrop" aria-hidden="true"></div><div class="film-grain" aria-hidden="true"></div><div class="hero__content"><div class="studio-stamp">${brandMarkup()}</div><p class="kicker">Un jeu de culture cinéma · deux à dix joueurs</p><h1>Le dernier<br><span>à l’écran.</span></h1><p class="hero__intro">Reliez chaque acteur au précédent par un film commun. Bluffez, démasquez, survivez : la culture ciné décide du dernier debout.</p><div class="hero__actions"><a class="button button--gold" href="${routeUrl("/setup")}" data-nav>Nouvelle partie <span>→</span></a>${hasGame ? `<a class="button button--ghost" href="${routeUrl("/play")}" data-nav>Reprendre la partie <span>↗</span></a>` : ""}<a class="button button--text" href="${routeUrl("/profiles")}" data-nav>Profils &amp; succès</a></div><p class="hero__fineprint">Sans compte · sans connexion · sauvegardé sur cet appareil</p></div><div class="hero__credits">CINÉFIL PICTURES · PRÉSENTE</div></main>`;
}

function setupMarkup() {
  const setup = state.setup ?? { names: ["", ""], themeId: "classic", mode: "classic", livesPerPlayer: 3, turnSeconds: 30, allowBluffChallenge: true };
  setup.mode ??= "classic";
  state.setup = setup;
  const names = setup.names.map((name, index) => `<div class="player-row"><span class="player-number">${String(index + 1).padStart(2, "0")}</span><input class="field" data-player-index="${index}" value="${escapeHtml(name)}" placeholder="Nom du joueur ${index + 1}" maxlength="24" autocomplete="off">${setup.mode !== "voice" && setup.names.length > 2 ? `<button class="icon-button" data-remove-player="${index}" aria-label="Retirer ${escapeHtml(name || `le joueur ${index + 1}`)}">×</button>` : ""}</div>`).join("");
  return shell(`<section class="form-page">
    <div class="section-heading"><p class="kicker">Pré-production</p><h1>Nouvelle partie</h1><p>Installez-vous. Un seul écran, plusieurs joueurs, zéro compte.</p></div>
    <section class="panel panel--paper"><div class="panel__title"><span class="panel__number">01</span><div><h2>Le casting</h2><p>${setup.mode === "voice" ? "Le mode vocal se joue en face-à-face." : "Ajoutez les personnes autour de la table."}</p></div></div><div class="players-list">${names}</div>${setup.mode === "classic" ? `<button class="add-player" data-add-player ${setup.names.length >= 10 ? "disabled" : ""}>＋ Ajouter un joueur</button>` : ""}</section>
    <section class="panel"><div class="panel__title"><span class="panel__number">02</span><div><h2>La prise</h2><p>Choisissez comment les noms entrent dans la chaîne.</p></div></div><div class="theme-grid mode-grid"><button class="theme-card ${setup.mode === "classic" ? "theme-card--selected" : ""}" data-mode="classic"><span class="theme-card__icon">⌨</span><b>Classique</b><small>Saisie, autocomplétion et passage d’écran</small></button><button class="theme-card ${setup.mode === "voice" ? "theme-card--selected" : ""}" data-mode="voice"><span class="theme-card__icon">◉</span><b>Vocal passif</b><small>Deux joueurs, écoute continue et buzzer central</small></button></div>${setup.mode === "voice" ? `<p class="privacy-note">Le micro ne démarre qu’après consentement explicite. La transcription est traitée par le moteur vocal du navigateur.</p>` : ""}</section>
    <section class="panel"><div class="panel__title"><span class="panel__number">03</span><div><h2>Le décor</h2><p>Choisissez votre terrain de jeu.</p></div></div><div class="theme-grid"><button class="theme-card ${setup.themeId === "classic" ? "theme-card--selected" : ""}" data-theme="classic"><span class="theme-card__icon">◎</span><b>Classique</b><small>Tous les artistes et toutes les œuvres</small></button><button class="theme-card ${setup.themeId === "fr" ? "theme-card--selected" : ""}" data-theme="fr"><span class="theme-card__icon">✦</span><b>French Touch</b><small>Les comédies et classiques français</small></button></div></section>
    <section class="panel"><div class="panel__title"><span class="panel__number">04</span><div><h2>Les règles</h2><p>Un peu de tension ne fait jamais de mal.</p></div></div><div class="range-setting"><label for="lives-range"><span>Vies par joueur</span><strong id="lives-value">${setup.livesPerPlayer}</strong></label><input id="lives-range" type="range" min="1" max="5" value="${setup.livesPerPlayer}"></div><div class="range-setting"><label for="timer-range"><span>Chrono par tour</span><strong id="timer-value">${setup.turnSeconds === 0 ? "∞" : `${setup.turnSeconds}s`}</strong></label><input id="timer-range" type="range" min="0" max="60" step="5" value="${setup.turnSeconds}" ${setup.turnSeconds === 0 ? "disabled" : ""}><label class="check-row"><input id="no-timer" type="checkbox" ${setup.turnSeconds === 0 ? "checked" : ""}><span>Jouer sans chrono</span></label></div><label class="check-row"><input id="allow-bluff" type="checkbox" ${setup.allowBluffChallenge ? "checked" : ""}><span>Autoriser les défis de bluff</span></label></section>
    <button class="button button--gold button--wide" data-start-game>Lancer la partie <span>→</span></button><p class="form-note">${setup.mode === "voice" ? "Deux noms sont nécessaires pour ouvrir les micros." : "Il faut au moins deux noms pour tourner la première bobine."}</p>
  </section>`, { back: "/", eyebrow: "Casting call" });
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
    storage.saveCurrent(state.game);
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

function gameHeader() {
  const player = currentPlayer(state.game);
  const timer = state.timeLeft === null ? (state.game.config.turnSeconds ? `${state.game.config.turnSeconds}s` : "∞") : `${state.timeLeft}s`;
  return `<div class="game-status"><div><small>Chaîne</small><strong>${state.game.chain.length}</strong></div><div class="game-status__player"><small>À vous, ${escapeHtml(player.name)}</small>${livesMarkup(player.lives)}</div><div class="game-status__timer ${state.timeLeft !== null && state.timeLeft <= 5 ? "game-status__timer--urgent" : ""}"><small>Temps</small><strong data-timer>${timer}</strong></div></div>`;
}

function roleLabel(person) {
  const role = person.roles?.[0] ?? "artist";
  return ({ acting: "Interprète", directing: "Réalisation", writing: "Scénario", production: "Production", artist: "Artiste" })[role] ?? role;
}

function suggestionsMarkup() {
  return state.suggestions.map((person, index) => {
    const details = person.knownFor?.length
      ? person.knownFor.join(" · ")
      : `${roleLabel(person)} · ${person.creditCount ?? person.films?.length ?? 0} crédit${(person.creditCount ?? person.films?.length ?? 0) > 1 ? "s" : ""}`;
    const source = String(person.origin ?? "").includes("tmdb") ? "TMDb" : "Local";
    return `<button type="button" role="option" data-suggestion-index="${index}" aria-selected="${state.selectedPerson?.id === person.id}">${person.profilePath ? `<img src="${escapeHtml(person.profilePath)}" alt="" loading="lazy">` : `<span class="suggestion-avatar" aria-hidden="true">${escapeHtml(person.name.slice(0, 1))}</span>`}<span><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(details)}</small></span><em>${source}</em></button>`;
  }).join("");
}

function suggestionHint() {
  if (state.selectedPerson) return `${state.selectedPerson.name} sélectionné · ${String(state.selectedPerson.origin ?? "").includes("tmdb") ? "filmographie enrichie à la validation" : "snapshot local"}.`;
  if (!state.input.trim()) return `Snapshot ${database.snapshotId ?? "local"} · disponible hors connexion.`;
  if (state.searchStatus === "loading") return "Recherche locale terminée · interrogation du catalogue étendu…";
  if (state.catalogStatus.static) return "Catalogue embarqué enrichi · aucune clé API n’est exposée par GitHub Pages.";
  if (state.catalogStatus.configured === false) return "Catalogue local actif · ajoutez TMDB_API_TOKEN au serveur pour la recherche étendue.";
  if (state.catalogStatus.online === false) return "Hors connexion · résultats du snapshot et du cache local.";
  if (!state.suggestions.length) return "Artiste hors base — le groupe pourra l’accepter par vote.";
  return `${state.suggestions.length} proposition${state.suggestions.length > 1 ? "s" : ""} · choisissez la bonne identité pour éviter une ambiguïté.`;
}

function renderSuggestions() {
  const container = document.querySelector("#actor-suggestions");
  if (container) container.innerHTML = suggestionsMarkup();
  const hint = document.querySelector(".input-hint");
  if (hint) {
    hint.textContent = suggestionHint();
    hint.classList.remove("input-hint--error");
  }
  const submit = document.querySelector("[data-submit-actor]");
  if (submit) submit.disabled = !state.input.trim();
}

function stopSearch() {
  if (state.searchTimer) window.clearTimeout(state.searchTimer);
  state.searchTimer = null;
  state.searchAbort?.abort();
  state.searchAbort = null;
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
      const result = await catalog.search(requested, { themeId: state.game.config.themeId, excluded: state.game.chain, limit: 8, signal: controller.signal });
      if (normalizeText(state.input) !== normalizeText(requested)) return;
      state.suggestions = result.results;
      state.catalogStatus = result.remote;
      state.searchStatus = "done";
      renderSuggestions();
    } catch (error) {
      if (error.name !== "AbortError") {
        state.searchStatus = "error";
        state.catalogStatus = { ...catalog.getState(), online: false };
        renderSuggestions();
      }
    } finally {
      if (state.searchAbort === controller) state.searchAbort = null;
    }
  }, 220);
}

function voiceActivePlayer() {
  if (state.pending?.challengerId) return state.game.players.find((player) => player.id === state.pending.challengerId) ?? currentPlayer(state.game);
  return currentPlayer(state.game);
}

function compactVoiceCandidate(person, confidence = person.confidence ?? person.matchScore ?? 0.65) {
  return {
    id: person.id ?? `spoken:${normalizeText(person.name)}`,
    name: person.name,
    confidence,
    origin: person.origin ?? person.source ?? "local",
    roles: person.roles ?? [],
    knownFor: person.knownFor ?? [],
    externalIds: person.externalIds ?? {},
  };
}

function voiceCandidateList(entry, { review = false, side = "" } = {}) {
  if (!entry?.candidates?.length) return `<p class="voice-empty">Aucune proposition</p>`;
  const selected = review ? state.voice.review?.selected?.[side] : entry.selected;
  const editable = review || (entry === state.voice.entries.at(-1) && Boolean(state.pending));
  return `<div class="voice-candidates">${entry.candidates.map((candidate, index) => `<button type="button" class="voice-candidate ${selected === index ? "voice-candidate--selected" : ""}" ${review ? `data-review-candidate="${index}" data-review-side="${side}"` : `data-voice-candidate="${index}" data-voice-entry="${entry.id}"`} ${editable ? "" : "disabled"}><span>${escapeHtml(candidate.name)}</span><small>${candidateConfidenceLabel(candidate.confidence)}</small></button>`).join("")}</div>`;
}

function lastVoiceEntryFor(playerId) {
  return [...state.voice.entries].reverse().find((entry) => entry.playerId === playerId) ?? null;
}

function voiceReviewMarkup() {
  const review = state.voice.review;
  const left = review?.left;
  const right = review?.right;
  return shell(`<section class="voice-review"><p class="kicker">Buzzer bluff</p><h1>Qu’avez-vous vraiment dit&nbsp;?</h1><p class="voice-review__intro">Sélectionnez les deux dernières identités, puis laissez le moteur vérifier la liaison.</p><div class="voice-review__grid"><article><small>Nom précédent · ${escapeHtml(left?.playerName ?? "Joueur")}</small><strong>${escapeHtml(left?.transcript ?? "")}</strong>${voiceCandidateList(left, { review: true, side: "left" })}</article><span class="voice-review__link">↔</span><article><small>Nom proposé · ${escapeHtml(right?.playerName ?? "Joueur")}</small><strong>${escapeHtml(right?.transcript ?? "")}</strong>${voiceCandidateList(right, { review: true, side: "right" })}</article></div>${state.voice.error ? `<p class="voice-error" role="alert">${escapeHtml(state.voice.error)}</p>` : ""}<div class="decision-grid"><button class="button button--ghost" data-cancel-voice-review>Reprendre l’écoute</button><button class="button button--red" data-resolve-voice-review>Vérifier le bluff</button></div></section>`, { back: "/", eyebrow: "Voice review" });
}

function voicePlayerSection(player, index, activePlayer) {
  const active = player.id === activePlayer.id;
  const entry = lastVoiceEntryFor(player.id);
  const timer = active ? (state.game.config.turnSeconds ? (state.timeLeft ?? state.game.config.turnSeconds) : "∞") : "—";
  return `<section class="voice-player voice-player--${index + 1} ${active ? "voice-player--active" : ""}" aria-label="${escapeHtml(player.name)}${active ? ", à vous" : ""}"><div class="voice-player__head"><div><small>Joueur ${index + 1}</small><h2>${escapeHtml(player.name)}</h2></div>${livesMarkup(player.lives, true)}</div><div class="voice-clock ${active && Number(timer) <= 5 ? "voice-clock--urgent" : ""}"><span>${timer}${Number.isFinite(timer) ? "s" : ""}</span><small>${active ? "À vous de parler" : "En attente"}</small></div><div class="voice-detection"><small>Dernière détection</small><strong>${escapeHtml(entry?.candidates?.[entry.selected]?.name ?? "—")}</strong>${entry ? voiceCandidateList(entry) : `<p class="voice-empty">Prononcez un nom d’artiste</p>`}</div></section>`;
}

function voiceMarkup() {
  if (state.voice.review) return voiceReviewMarkup();
  const activePlayer = voiceActivePlayer();
  const players = state.game.players;
  const listeningLabel = state.voice.listening ? "Écoute active" : state.voice.consent ? "Démarrage du micro…" : "Micro en pause";
  const buzzerReady = Boolean(state.pending && state.game.config.allowBluffChallenge);
  return shell(`<section class="voice-page"><div class="voice-status"><span class="voice-listening ${state.voice.listening ? "voice-listening--on" : ""}"><i></i>${listeningLabel}</span><span>${database.snapshotId ?? "Base locale"}</span></div><div class="voice-stage">${voicePlayerSection(players[0], 0, activePlayer)}<div class="voice-center"><div class="voice-wave ${state.voice.listening ? "voice-wave--on" : ""}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p data-voice-live aria-live="polite">${escapeHtml(state.voice.interim || state.voice.verdict || (state.pending ? "Bluffez maintenant, ou prononcez le nom suivant." : "La chaîne attend son prochain nom."))}</p><button class="voice-buzzer" data-voice-buzzer ${buzzerReady ? "" : "disabled"}><span>BLUFF</span><small>${buzzerReady ? "Interrompre et vérifier" : "Disponible après deux noms"}</small></button>${state.voice.supported ? `<button class="button button--ghost voice-mic" data-voice-toggle>${state.voice.consent ? "Mettre le micro en pause" : "Activer le micro"}</button>` : `<p class="voice-error">Reconnaissance vocale indisponible dans ce navigateur. La saisie de secours reste jouable.</p>`}<details class="voice-manual"><summary>Correction / saisie de secours</summary><form data-voice-manual-form><label for="voice-manual-input">Nom entendu pour ${escapeHtml(activePlayer.name)}</label><div><input id="voice-manual-input" class="field" autocomplete="off" placeholder="Nom de l’artiste"><button class="button button--gold" type="submit">Détecter</button></div></form></details>${state.voice.error ? `<p class="voice-error" role="alert">${escapeHtml(state.voice.error)}</p>` : ""}</div>${voicePlayerSection(players[1], 1, activePlayer)}</div><p class="voice-privacy">Le voyant rouge indique l’écoute. Vous pouvez couper le micro immédiatement; aucun fichier audio n’est stocké par Ciné-Fil.</p></section>`, { back: "/", eyebrow: "Passive voice mode" });
}

function ensureVoiceSession() {
  if (state.voice.session) return state.voice.session;
  state.voice.session = createSpeechSession({
    scope: window,
    lang: "fr-FR",
    onTranscript(event) {
      if (event.final) {
        state.voice.interim = "";
        handleVoiceTranscript(event.transcript);
      } else {
        state.voice.interim = event.transcript;
        const live = document.querySelector("[data-voice-live]");
        if (live) live.textContent = event.transcript || "…";
      }
    },
    onState(event) {
      state.voice.listening = event.listening;
      if (event.listening) ensureVoiceTimer();
      document.querySelector(".voice-listening")?.classList.toggle("voice-listening--on", event.listening);
    },
    onError(event) {
      state.voice.error = event.code === "not-allowed" ? "Accès au micro refusé. Autorisez-le dans le navigateur ou utilisez la saisie de secours." : `Micro indisponible (${event.code}).`;
      if (event.terminal) state.voice.consent = false;
      renderRoute();
    },
  });
  return state.voice.session;
}

function startVoiceSession() {
  state.voice.consent = true;
  state.voice.error = null;
  const started = ensureVoiceSession().start();
  if (!started) state.voice.error = "Le micro n’a pas pu démarrer. La saisie de secours reste disponible.";
}

function stopVoiceSession({ destroy = true } = {}) {
  if (!state.voice) return;
  if (destroy) state.voice.session?.destroy();
  else state.voice.session?.stop();
  if (destroy) state.voice.session = null;
  state.voice.listening = false;
  state.voice.consent = false;
  stopTimer();
}

async function voiceCandidatesFor(transcript) {
  let candidates = resolveVoiceTranscript(transcript, database, { themeId: state.game.config.themeId, excluded: state.game.chain, limit: 4 }).map((person) => compactVoiceCandidate(person));
  if (candidates.length < 2 && normalizeText(transcript).length >= 2) {
    const remote = await catalog.search(transcript, { themeId: state.game.config.themeId, excluded: state.game.chain, limit: 4 });
    state.catalogStatus = remote.remote;
    const combined = [...candidates];
    for (const person of remote.results) {
      if (!combined.some((candidate) => candidate.id === person.id || normalizeText(candidate.name) === normalizeText(person.name))) combined.push(compactVoiceCandidate(person, person.matchScore ?? 0.64));
    }
    candidates = combined.slice(0, 4);
  }
  if (!candidates.length) candidates = [{ id: `spoken:${normalizeText(transcript)}`, name: transcript.trim(), confidence: 0.35, origin: "vote", roles: [], knownFor: [], externalIds: {} }];
  return candidates;
}

async function hydrateVoiceCandidate(candidate) {
  if (!candidate) return null;
  try {
    return await catalog.hydrate(candidate) ?? database.findActor(candidate.name) ?? candidate;
  } catch {
    state.catalogStatus = { ...catalog.getState(), online: false };
    return database.findActor(candidate.name) ?? candidate;
  }
}

async function handleVoiceTranscript(transcript) {
  const spoken = String(transcript ?? "").trim();
  if (!spoken || state.voice.processing || state.voice.review || state.game.status !== "in-progress") return;
  state.voice.processing = true;
  state.voice.error = null;
  try {
    const speakingPlayer = voiceActivePlayer();
    const candidates = await voiceCandidatesFor(spoken);
    const selectedPerson = await hydrateVoiceCandidate(candidates[0]);
    if (state.pending) {
      state.game = resolvePending(state.game, state.pending, { challenged: false });
      state.pending = null;
    }
    const active = currentPlayer(state.game);
    if (active.id !== speakingPlayer.id) throw new Error("Le tour a changé pendant la reconnaissance. Répétez le nom.");
    const result = proposeActor(state.game, selectedPerson?.name ?? candidates[0].name, database);
    const entry = {
      id: globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}`,
      playerId: active.id,
      playerName: active.name,
      transcript: spoken,
      candidates,
      selected: 0,
      at: Date.now(),
    };
    state.voice.entries = [...state.voice.entries, entry].slice(-12);
    if (result.type === "pending") state.pending = result.pending;
    else state.game = result.game;
    state.voice.verdict = `${active.name} · ${candidates[0].name}`;
    state.timeLeft = null;
    storage.saveCurrent(state.game);
    if (state.game.status === "finished") navigate("/results");
    else renderRoute();
  } catch (error) {
    state.voice.error = error.message;
    renderRoute();
  } finally {
    state.voice.processing = false;
  }
}

function openVoiceReview() {
  if (!state.pending) return;
  stopVoiceSession({ destroy: false });
  const currentEntry = state.voice.entries.at(-1);
  const previousEntry = state.voice.entries.at(-2) ?? {
    id: "chain-previous",
    playerId: state.pending.challengerId,
    playerName: state.game.players.find((player) => player.id === state.pending.challengerId)?.name ?? "Joueur précédent",
    transcript: state.game.chain.at(-1),
    candidates: [{ id: "chain-previous", name: state.game.chain.at(-1), confidence: 1, origin: "chain", externalIds: {} }],
    selected: 0,
  };
  state.voice.review = { left: previousEntry, right: currentEntry, selected: { left: previousEntry.selected ?? 0, right: currentEntry?.selected ?? 0 } };
  renderRoute();
}

async function resolveVoiceReview() {
  const review = state.voice.review;
  if (!review) return;
  state.voice.error = null;
  try {
    const leftCandidate = review.left.candidates[review.selected.left];
    const rightCandidate = review.right.candidates[review.selected.right];
    const [leftPerson, rightPerson] = await Promise.all([hydrateVoiceCandidate(leftCandidate), hydrateVoiceCandidate(rightCandidate)]);
    const corrected = replaceLastActor(state.game, leftPerson?.name ?? leftCandidate.name, database);
    const result = proposeActor(corrected, rightPerson?.name ?? rightCandidate.name, database);
    if (result.type !== "pending") throw new Error("La liaison à vérifier est incomplète.");
    const pending = result.pending;
    state.game = resolvePending(result.game, pending, { challenged: true });
    review.left.selected = review.selected.left;
    review.right.selected = review.selected.right;
    state.voice.verdict = pending.wasValid ? `Liaison valide · ${pending.sharedFilms.join(" · ")}` : "Bluff confirmé · aucune œuvre commune";
    state.pending = null;
    state.voice.review = null;
    state.timeLeft = null;
    storage.saveCurrent(state.game);
    if (state.game.status === "finished") navigate("/results");
    else {
      startVoiceSession();
      renderRoute();
    }
  } catch (error) {
    state.voice.error = error.message;
    renderRoute();
  }
}

async function selectCurrentVoiceCandidate(entryId, candidateIndex) {
  const entry = state.voice.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry !== state.voice.entries.at(-1) || !state.pending) return;
  try {
    const candidate = entry.candidates[candidateIndex];
    const person = await hydrateVoiceCandidate(candidate);
    const result = proposeActor(state.game, person?.name ?? candidate.name, database);
    if (result.type !== "pending") return;
    entry.selected = candidateIndex;
    state.pending = result.pending;
    state.voice.verdict = `${entry.playerName} · ${candidate.name}`;
    renderRoute();
  } catch (error) {
    state.voice.error = error.message;
    renderRoute();
  }
}

function ensureVoiceTimer() {
  if (state.timer || !state.voice.consent || state.voice.review || !state.game.config.turnSeconds) return;
  if (state.timeLeft === null) state.timeLeft = state.game.config.turnSeconds;
  state.timer = window.setInterval(() => {
    state.timeLeft -= 1;
    document.querySelectorAll(".voice-player--active .voice-clock span").forEach((element) => { element.textContent = `${state.timeLeft}s`; });
    document.querySelector(".voice-player--active .voice-clock")?.classList.toggle("voice-clock--urgent", state.timeLeft <= 5);
    if (state.timeLeft > 0) return;
    stopTimer();
    if (state.pending) {
      state.game = resolvePending(state.game, state.pending, { challenged: false });
      state.pending = null;
    }
    state.game = resolvePending(state.game, timeoutPending(state.game), { challenged: false });
    state.voice.verdict = "Temps écoulé";
    state.timeLeft = null;
    storage.saveCurrent(state.game);
    if (state.game.status === "finished") navigate("/results");
    else renderRoute();
  }, 1000);
}

function bindVoice() {
  document.querySelector("[data-voice-toggle]")?.addEventListener("click", () => {
    if (state.voice.consent) stopVoiceSession({ destroy: false });
    else startVoiceSession();
    renderRoute();
  });
  document.querySelector("[data-voice-buzzer]")?.addEventListener("click", openVoiceReview);
  document.querySelector("[data-voice-manual-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#voice-manual-input");
    if (input?.value.trim()) handleVoiceTranscript(input.value);
  });
  document.querySelectorAll("[data-voice-candidate]").forEach((button) => button.addEventListener("click", () => selectCurrentVoiceCandidate(button.dataset.voiceEntry, Number(button.dataset.voiceCandidate))));
  document.querySelectorAll("[data-review-candidate]").forEach((button) => button.addEventListener("click", () => {
    state.voice.review.selected[button.dataset.reviewSide] = Number(button.dataset.reviewCandidate);
    renderRoute();
  }));
  document.querySelector("[data-cancel-voice-review]")?.addEventListener("click", () => {
    state.voice.review = null;
    startVoiceSession();
    renderRoute();
  });
  document.querySelector("[data-resolve-voice-review]")?.addEventListener("click", resolveVoiceReview);
  ensureVoiceTimer();
}

function playMarkup() {
  const game = state.game;
  if (game.config.mode === "voice") return voiceMarkup();
  const player = currentPlayer(game);
  const previous = game.chain.at(-1);
  if (state.phase === "pass") {
    return shell(`<section class="play-page play-page--center"><p class="kicker">Passez l’écran à</p><h1 class="player-call">${escapeHtml(player.name)}</h1><div class="player-lives">${livesMarkup(player.lives, true)}</div><div class="scene-card"><small>${previous ? "Acteur précédent" : "C’est toi qui démarres"}</small><strong>${escapeHtml(previous || "Choisis l’acteur de départ")}</strong></div><button class="button button--gold button--wide" data-ready>Je suis prêt <span>→</span></button></section>`, { back: "/", eyebrow: "One screen · many players" });
  }
  if (state.phase === "input") {
    if (!state.suggestions.length && state.input) state.suggestions = database.searchPeople(state.input, { themeId: game.config.themeId, excluded: game.chain, limit: 8 });
    return shell(`<section class="play-page"><div class="play-page__top">${gameHeader()}</div><div class="prompt-card"><small>${previous ? "Relie cet acteur à" : "Acteur de départ"}</small><h1>${escapeHtml(previous || "À toi de lancer la partie")}</h1></div><label class="field-label" for="actor-input">Ton artiste</label><input id="actor-input" class="field field--actor" value="${escapeHtml(state.input)}" placeholder="Nom de l’artiste…" autocomplete="off" aria-autocomplete="list" aria-controls="actor-suggestions" autofocus><div id="actor-suggestions" class="suggestions suggestions--people" role="listbox">${suggestionsMarkup()}</div><p class="input-hint" aria-live="polite">${suggestionHint()}</p><button class="button button--gold button--wide" data-submit-actor ${!state.input.trim() ? "disabled" : ""}>Valider <span>→</span></button></section>`, { back: "/", eyebrow: "The chain" });
  }
  if (state.phase === "challenge" && state.pending) {
    const challenger = game.players.find((candidate) => candidate.id === state.pending.challengerId);
    return shell(`<section class="play-page play-page--center"><p class="kicker">${escapeHtml(player.name)} propose</p><h1 class="actor-reveal">${escapeHtml(state.pending.proposedActor)}</h1><p class="reveal-subtitle">pour relier à <b>${escapeHtml(previous)}</b></p><div class="scene-card scene-card--decision"><p><b>${escapeHtml(challenger?.name || "Le joueur suivant")}</b>, à toi de décider.</p><ul><li>Laisser passer : le coup est accepté.</li><li>Bluff : on vérifie dans la filmographie.</li></ul></div><div class="decision-grid"><button class="button button--ghost" data-pass-challenge>Laisser passer</button><button class="button button--red" data-call-bluff>Bluff !</button></div></section>`, { back: "/", eyebrow: "The courtroom" });
  }
  const valid = Boolean(state.pending?.wasValid);
  return shell(`<section class="play-page play-page--center"><span class="verdict ${valid ? "verdict--valid" : "verdict--invalid"}">${valid ? "Valide" : "Invalide"}</span><h1 class="connection">${escapeHtml(previous)} <span>↔</span> <em>${escapeHtml(state.pending?.proposedActor)}</em></h1>${valid && state.pending.sharedFilms.length ? `<div class="film-proof"><small>Film${state.pending.sharedFilms.length > 1 ? "s" : ""} commun${state.pending.sharedFilms.length > 1 ? "s" : ""}</small><ul>${state.pending.sharedFilms.map((film) => `<li>${escapeHtml(film)}</li>`).join("")}</ul></div>` : ""}${state.revealChallenged ? `<p class="reveal-note">Bluff annoncé — ${valid ? "ce n’était pas un bluff." : "c’était bien un bluff."}</p>` : ""}${state.pending?.method === "timeout" ? `<p class="reveal-note">Le chrono a mangé la réplique.</p>` : ""}<button class="button button--gold button--wide" data-continue>Continuer <span>→</span></button></section>`, { back: "/", eyebrow: "The verdict" });
}

function bindPlay() {
  if (state.game.config.mode === "voice") {
    bindVoice();
    return;
  }
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
      state.selectedPerson = null;
      state.suggestions = database.searchPeople(state.input, { themeId: state.game.config.themeId, excluded: state.game.chain, limit: 8 });
      state.searchStatus = state.input.trim().length >= 2 ? "loading" : "idle";
      renderSuggestions();
      scheduleCatalogSearch(state.input);
    });
    actorInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitActor();
    });
  }
  document.querySelector("#actor-suggestions")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-suggestion-index]");
    if (!button) return;
    const person = state.suggestions[Number(button.dataset.suggestionIndex)];
    if (!person) return;
    state.selectedPerson = person;
    state.input = person.name;
    actorInput.value = person.name;
    renderSuggestions();
    document.querySelector("[data-submit-actor]")?.removeAttribute("disabled");
    actorInput.focus();
  });
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

async function submitActor() {
  if (!state.input.trim()) return;
  stopSearch();
  const button = document.querySelector("[data-submit-actor]");
  if (button) {
    button.disabled = true;
    button.firstChild.textContent = "Vérification… ";
  }
  try {
    let person = state.selectedPerson;
    if (!person || normalizeText(person.name) !== normalizeText(state.input)) person = database.findActor(state.input, state.game.config.themeId);
    if (person) {
      try {
        person = await catalog.hydrate(person) ?? person;
      } catch {
        state.catalogStatus = { ...catalog.getState(), online: false };
      }
    }
    const result = proposeActor(state.game, person?.name ?? state.input, database);
    state.input = "";
    state.suggestions = [];
    state.selectedPerson = null;
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
    if (button) button.disabled = false;
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
    root.innerHTML = shell(`<section class="empty-state"><p class="kicker">Salle vide</p><h1>Aucune partie terminée.</h1><a class="button button--gold" href="${routeUrl("/setup")}" data-nav>Tourner une partie</a></section>`, { back: "/" });
    return;
  }
  state.game = game;
  const result = recordFinishedGame(game, storage);
  state.newAchievements = result.newAchievements;
  const ordered = [...game.players].sort((left, right) => (right.id === game.winnerId) - (left.id === game.winnerId) || right.score - left.score);
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = state.newAchievements.map((id) => ACHIEVEMENTS.find((achievement) => achievement.id === id)).filter(Boolean);
  root.innerHTML = shell(`<section class="results-page"><div class="credits-card"><p class="kicker">Ciné-Fil Pictures présente</p><small>Dans le rôle du vainqueur</small><h1>${escapeHtml(winner?.name ?? "Personne")}</h1><p>Une chaîne de ${game.chain.length} acteurs</p><div class="credits-card__line"></div><small>Réalisé par</small><b>Vous tous</b></div><section class="panel panel--ranking"><div class="panel__title"><span class="panel__number">01</span><div><h2>Le classement</h2><p>Le générique défile, les scores restent.</p></div></div><ol class="ranking">${ordered.map((player, index) => `<li class="ranking__row ${player.id === game.winnerId ? "ranking__row--winner" : ""}"><span class="ranking__place">#${index + 1}</span><strong>${escapeHtml(player.name)}</strong><span>${player.filmsFound} films · ${player.score} pts · série ${player.bestStreak}</span></li>`).join("")}</ol></section>${newAchievements.length ? `<section class="panel"><div class="panel__title"><span class="panel__number">02</span><div><h2>Nouveau succès</h2><p>Une nouvelle ligne au palmarès.</p></div></div><div class="achievement-list">${newAchievements.map((achievement) => `<div class="achievement"><span>${achievement.icon}</span><div><b>${achievement.label}</b><small>${achievement.description}</small></div></div>`).join("")}</div></section>` : ""}<section class="panel"><div class="panel__title"><span class="panel__number">03</span><div><h2>Chaîne complète</h2><p>La bobine entière, sans coupure.</p></div></div><p class="chain-line">${game.chain.map((actor, index) => `<span>${escapeHtml(actor)}</span>${index < game.chain.length - 1 ? " <b>→</b> " : ""}`).join("")}</p></section><div class="results-actions"><button class="button button--gold" data-replay>Rejouer <span>↗</span></button><a class="button button--ghost" href="/" data-nav>Accueil</a></div></section>`, { back: "/", eyebrow: "End credits" });
  document.querySelector("[data-replay]")?.addEventListener("click", () => {
    const names = game.players.map((player) => player.name);
    state.game = createGame({ names, config: game.config });
    storage.saveCurrent(state.game);
    navigate("/play");
  });
}

function renderProfiles() {
  const profiles = Object.values(storage.loadProfiles()).sort((left, right) => right.wins - left.wins || right.xp - left.xp);
  const diagnosticEntries = diagnostics.load();
  root.innerHTML = shell(`<section class="profiles-page"><div class="section-heading"><p class="kicker">Archives du studio</p><h1>Profils</h1><p>Les statistiques cumulées de tous les joueurs sur cet appareil.</p></div>${state.transferNotice ? `<p class="transfer-notice ${state.transferNotice.type === "error" ? "transfer-notice--error" : ""}" role="status">${escapeHtml(state.transferNotice.message)}</p>` : ""}${profiles.length ? `<div class="profile-list">${profiles.map((profile) => `<article class="profile-card"><div class="profile-card__head"><div><h2>${escapeHtml(profile.name)}</h2><p>${levelForXp(profile.xp)} · ${profile.xp} XP</p></div><span>${profile.games} partie${profile.games > 1 ? "s" : ""}</span></div><div class="profile-stats"><div><b>${profile.wins}</b><small>Victoires</small></div><div><b>${profile.filmsFound}</b><small>Films</small></div><div><b>${profile.bluffsSucceeded}</b><small>Bluffs</small></div><div><b>${profile.bluffsCaught}</b><small>Démasqués</small></div></div>${profile.achievements?.length ? `<div class="profile-achievements">${profile.achievements.map((id) => { const achievement = ACHIEVEMENTS.find((item) => item.id === id); return achievement ? `<span title="${escapeHtml(achievement.description)}">${achievement.icon} ${escapeHtml(achievement.label)}</span>` : ""; }).join("")}</div>` : ""}</article>`).join("")}</div>` : `<div class="empty-state empty-state--panel"><p class="kicker">Pas encore de générique</p><h2>Aucun profil.</h2><p>Terminez une partie pour créer le premier.</p></div>`}<section class="panel all-achievements"><div class="panel__title"><span class="panel__number">∞</span><div><h2>Tous les succès</h2><p>Les trophées qui attendent leur scène.</p></div></div><div class="achievement-grid">${ACHIEVEMENTS.map((achievement) => `<div class="achievement achievement--muted"><span>${achievement.icon}</span><div><b>${achievement.label}</b><small>${achievement.description}</small></div></div>`).join("")}</div></section><section class="panel data-tools"><div class="panel__title"><span class="panel__number">↥</span><div><h2>Vos archives</h2><p>Transportez les parties et profils sans créer de compte.</p></div></div><div class="data-tools__buttons"><button class="button button--gold" data-export-backup>Exporter</button><button class="button button--ghost" data-import-backup>Importer</button><input class="sr-only" type="file" accept="application/json,.json" data-backup-file></div><p>Une importation remplace les données locales après validation du fichier.</p><label class="check-row"><input type="checkbox" data-large-text-toggle ${storage.loadSettings().largeText ? "checked" : ""}><span>Agrandir tous les textes de l’interface</span></label><label class="check-row"><input type="checkbox" data-diagnostics-toggle ${diagnostics.isEnabled() ? "checked" : ""}><span>Conserver un journal d’erreurs local (${diagnosticEntries.length}/30)</span></label>${diagnosticEntries.length ? `<button class="button button--text" data-clear-diagnostics>Effacer le journal local</button>` : ""}</section></section>`, { back: "/", eyebrow: "Hall of fame" });
  document.querySelector(".profiles-page")?.insertAdjacentHTML("beforeend", `<aside class="tmdb-credit" aria-label="Crédits des données cinéma"><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img src="${assetUrl("assets/tmdb-logo.svg")}" alt="The Movie Database"></a><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p></aside>`);
  bindProfileTools();
}

function readCatalogCache() {
  try { return JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) ?? "null"); } catch { return null; }
}

function downloadBackup() {
  const backup = createBackup(storage, { catalogCache: readCatalogCache() });
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFilename();
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  state.transferNotice = { type: "success", message: "Sauvegarde exportée. Gardez ce fichier pour restaurer le jeu sur un autre appareil." };
}

async function importBackupFile(file) {
  try {
    if (!file) return;
    const backup = parseBackup(await file.text());
    const result = restoreBackup(backup, storage, { storage: localStorage, catalogCacheKey: CATALOG_CACHE_KEY });
    state.game = result.current;
    document.documentElement.toggleAttribute("data-large-text", storage.loadSettings().largeText === true);
    state.transferNotice = { type: "success", message: `${result.profiles} profil${result.profiles > 1 ? "s" : ""} et ${result.games} partie${result.games > 1 ? "s" : ""} restaurés.` };
  } catch (error) {
    diagnostics.capture(error, { phase: "backup-import" });
    state.transferNotice = { type: "error", message: error.message };
  }
  renderProfiles();
}

function bindProfileTools() {
  document.querySelector("[data-export-backup]")?.addEventListener("click", () => {
    downloadBackup();
    renderProfiles();
  });
  document.querySelector("[data-import-backup]")?.addEventListener("click", () => document.querySelector("[data-backup-file]")?.click());
  document.querySelector("[data-backup-file]")?.addEventListener("change", (event) => importBackupFile(event.target.files?.[0]));
  document.querySelector("[data-large-text-toggle]")?.addEventListener("change", (event) => {
    const settings = { ...storage.loadSettings(), largeText: event.target.checked };
    storage.saveSettings(settings);
    document.documentElement.toggleAttribute("data-large-text", event.target.checked);
    state.transferNotice = { type: "success", message: event.target.checked ? "Affichage agrandi activé." : "Affichage standard restauré." };
    renderProfiles();
  });
  document.querySelector("[data-diagnostics-toggle]")?.addEventListener("change", (event) => {
    diagnostics.setEnabled(event.target.checked);
    state.transferNotice = { type: "success", message: event.target.checked ? "Journal local activé. Rien n’est envoyé sur le réseau." : "Journal local désactivé et effacé." };
    renderProfiles();
  });
  document.querySelector("[data-clear-diagnostics]")?.addEventListener("click", () => {
    diagnostics.clear();
    state.transferNotice = { type: "success", message: "Journal local effacé." };
    renderProfiles();
  });
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
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", renderRoute);
renderRoute();
catalog.status().then((status) => {
  state.catalogStatus = status;
  if (state.phase === "input") renderSuggestions();
});
if ("serviceWorker" in navigator) {
  const registerServiceWorker = () => navigator.serviceWorker.register(assetUrl("sw.js"), { scope: APP_BASE }).catch((error) => diagnostics.capture(error, { phase: "service-worker" }));
  if (document.readyState === "complete") registerServiceWorker();
  else window.addEventListener("load", registerServiceWorker, { once: true });
}
