// Passive voice mode. Two seats facing each other, a buzzer between them.
//
// Listening never changes the game: it only fills the pool of propositions for whoever's turn it is, and nothing
// reaches the chain without a deliberate tap. The banner that used to spell out whose turn it was is gone — the
// inactive seat is dimmed, which says it without costing a line. What stayed is the hand-over animation: it is
// the confirmation that a validation actually landed.

import { normalizeText } from "../../game/database.js";
import {
  adjudicatePending,
  currentPlayer,
  proposeActor,
  replaceLastActor,
  resolvePending,
  timeoutPending,
} from "../../game/engine.js";
import { candidateConfidenceLabel, createVoiceResolver, spokenNameGuess } from "../../voice/entity-resolver.js";
import { createSpeechSession } from "../../voice/speech-session.js";
import {
  app,
  catalogStatusLabel,
  navigate,
  queueCreditsRefresh,
  refreshCatalogLabel,
  renderRoute,
  setCatalogStatus,
  state,
  stopTimer,
  path,
} from "../runtime.js";
import { escapeHtml, livesMarkup, portraitMarkup } from "../format.js";
import { verifyPendingLink } from "../link-check.js";
import { shell } from "../shell.js";
import { verificationCascadeMarkup, verificationPanelMarkup } from "../verification.js";
import { createVoiceTurn } from "../voice-state.js";

const VOICE_FLASH_MS = 2200;

// With a configured TMDb behind it, the remote catalogue is the only way to reach an artist the snapshot never
// had, so the gate follows the confidence bands the interface already shows rather than a fixed suspicion of the
// network. Above "très probable" the local reading needs no second opinion. A lone word is worth a query only
// when nothing local answers it: the local floor for a one-word span is 0.84, so a weak best means the surname is
// unknown here rather than mispronounced. Interim fragments never ask — they are the least informative queries —
// and a sentence already sent this turn never asks twice, which is what keeps a repeating recogniser cheap.
const REMOTE_VOICE_MAX_LOCAL = 0.92;
const REMOTE_VOICE_LONE_WORD_MAX_LOCAL = 0.7;
const REMOTE_VOICE_BUDGET = 6;

let voiceResolver = null;
const resolver = () => (voiceResolver ??= createVoiceResolver(app.database));

/* -----------------------------------------------------------------------------
   A live region that outlives every render
   -------------------------------------------------------------------------- */

let voiceAnnouncer = null;

function announcer() {
  if (voiceAnnouncer) return voiceAnnouncer;
  voiceAnnouncer = Object.assign(document.createElement("p"), { className: "sr-only" });
  voiceAnnouncer.setAttribute("role", "status");
  voiceAnnouncer.setAttribute("aria-live", "polite");
  voiceAnnouncer.setAttribute("aria-atomic", "true");
  document.body.append(voiceAnnouncer);
  return voiceAnnouncer;
}

function announceVoice(message) {
  if (!message) return;
  const element = announcer();
  // Clearing first makes an identical sentence announce again on the next turn.
  element.textContent = "";
  window.setTimeout(() => { element.textContent = message; }, 60);
}

/* -----------------------------------------------------------------------------
   Candidates
   -------------------------------------------------------------------------- */

function voiceActivePlayer() {
  if (state.pending?.challengerId) {
    return state.game.players.find((player) => player.id === state.pending.challengerId) ?? currentPlayer(state.game);
  }
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
    popularity: Number(person.popularity ?? 0),
    matchedText: person.matchedText ?? null,
    profilePath: person.profilePath ?? null,
  };
}

function voiceTurnCandidates() {
  return state.voice.turn.buffer.candidates();
}

// Whatever the player said, spelled as the recogniser heard it. It stays reachable unless the catalogue answered
// with near-certainty — an artist we simply do not know must never be a dead end.
function offCatalogueOffer() {
  const guess = spokenNameGuess(state.voice.turn.buffer.lastTranscript());
  if (!guess) return null;
  const known = app.database.findActor(guess, state.game.config.themeId);
  const name = known?.name ?? guess;
  const key = normalizeText(name);
  const taken = [...state.game.chain, state.pending?.proposedActor].filter(Boolean).map(normalizeText);
  if (taken.includes(key)) return null;
  const pool = voiceTurnCandidates();
  if (pool.some((candidate) => normalizeText(candidate.name) === key)) return null;
  if ((pool[0]?.confidence ?? 0) >= 0.93) return null;
  return { name, known: Boolean(known) };
}

function mergeVoiceCandidates(candidates, extra) {
  const merged = [...candidates];
  for (const person of extra) {
    if (merged.some((candidate) => normalizeText(candidate.name) === normalizeText(person.name))) continue;
    merged.push(person);
  }
  return merged.sort((left, right) => right.confidence - left.confidence).slice(0, 4);
}

function voiceCandidatesFor(alternatives) {
  // The proposition already on the table is not a legal answer either: offering it would let a tap erase it.
  const excluded = [...state.game.chain, state.pending?.proposedActor].filter(Boolean);
  const local = resolver().resolve(alternatives, {
    themeId: state.game.config.themeId,
    excluded,
    limit: 4,
    previousActor: state.game.chain.at(-1) ?? null,
  }).map((person) => compactVoiceCandidate(person));
  const query = spokenNameGuess(alternatives[0]?.transcript ?? "");
  // Saying a name twice is what a player does when nothing seems to happen. The turn remembers what the remote
  // catalogue answered for a sentence, so the repeat costs no call and — above all — does not retire the artist
  // only TMDb knew about.
  const remembered = query ? state.voice.turn.remoteResults.get(normalizeText(query)) ?? [] : [];
  return { candidates: mergeVoiceCandidates(local, remembered), local, excluded, query };
}

function worthAskingRemote({ local, query }, final) {
  if (!final || !query) return false;
  const best = local[0]?.confidence ?? 0;
  if (best >= (query.split(" ").length >= 2 ? REMOTE_VOICE_MAX_LOCAL : REMOTE_VOICE_LONE_WORD_MAX_LOCAL)) return false;
  return !state.voice.turn.remoteResults.has(normalizeText(query)) && state.voice.turn.remoteLookups < REMOTE_VOICE_BUDGET;
}

// A TMDb hit is a name, not a hearing. It enters at "probable" when it spells exactly what was heard and lower
// otherwise, and it never takes the lead from a local reading that is already probable.
function remoteVoiceConfidence(person, query, best) {
  const exact = normalizeText(person.name) === normalizeText(query);
  return Math.min(exact ? 0.82 : 0.7, best >= 0.78 ? best - 0.02 : 1);
}

async function remoteVoiceCandidates({ candidates, local, excluded, query }) {
  const turn = state.voice.turn;
  const key = normalizeText(query);
  turn.remoteResults.set(key, []);
  turn.remoteLookups += 1;
  const best = local[0]?.confidence ?? 0;
  try {
    const remote = await app.catalog.search(query, { themeId: state.game.config.themeId, excluded, limit: 4 });
    setCatalogStatus(remote.remote);
    const found = [];
    for (const person of remote.results) {
      // Only identities the snapshot genuinely lacks. A local person that the phonetic pass did not surface was
      // not misheard — it was rejected, and letting the looser text search re-inject it is how noise gets in.
      if (app.database.findActor(person.name, state.game.config.themeId)) continue;
      if (candidates.some((candidate) => normalizeText(candidate.name) === normalizeText(person.name))) continue;
      found.push(compactVoiceCandidate({ ...person, origin: "voice-tmdb" }, remoteVoiceConfidence(person, query, best)));
    }
    turn.remoteResults.set(key, found);
    return found.length ? mergeVoiceCandidates(candidates, found) : null;
  } catch {
    setCatalogStatus({ ...app.catalog.getState(), online: false });
    // Nothing was learned, so the next sentence may ask again once the network is back.
    turn.remoteResults.delete(key);
    return null;
  }
}

async function hydrateVoiceCandidate(candidate) {
  if (!candidate) return null;
  try {
    const person = await app.catalog.hydrate(candidate) ?? app.database.findActor(candidate.name) ?? candidate;
    setCatalogStatus(app.catalog.getState());
    return person;
  } catch {
    setCatalogStatus({ ...app.catalog.getState(), online: false });
    return app.database.findActor(candidate.name) ?? candidate;
  }
}

/* -----------------------------------------------------------------------------
   Markup
   -------------------------------------------------------------------------- */

function voiceCandidateList(entry, { review = false, side = "" } = {}) {
  if (!entry?.candidates?.length) return `<p class="voice-empty">Aucune proposition</p>`;
  const selected = review ? state.voice.review?.selected?.[side] : entry.selected;
  const editable = review
    ? !state.voice.review?.checking && !state.voice.review?.verification
    : entry === state.voice.entries.at(-1) && Boolean(state.pending);
  return `<div class="voice-candidates">${entry.candidates.map((candidate, index) => `<button type="button" class="voice-candidate ${selected === index ? "voice-candidate--selected" : ""}" ${review ? `data-review-candidate="${index}" data-review-side="${side}"` : `data-voice-candidate="${index}" data-voice-entry="${entry.id}"`} ${editable ? "" : "disabled"}><span>${escapeHtml(candidate.name)}</span><small>${candidateConfidenceLabel(candidate.confidence)}</small></button>`).join("")}</div>`;
}

function lastVoiceEntryFor(playerId) {
  return [...state.voice.entries].reverse().find((entry) => entry.playerId === playerId) ?? null;
}

// Nothing reaches the chain without a deliberate tap: the pool only ever proposes.
function voicePickListMarkup() {
  const candidates = voiceTurnCandidates();
  const offer = offCatalogueOffer();
  if (!candidates.length && !offer) return `<p class="voice-empty">Prononcez un nom d’artiste, il apparaîtra ici.</p>`;
  const promoted = Boolean(offer) && (candidates[0]?.confidence ?? 0) < 0.84;
  const picks = candidates.map((candidate, index) => `<button type="button" role="listitem" class="voice-pick ${index === 0 && !promoted ? "voice-pick--lead" : ""}" data-voice-validate="${index}">${portraitMarkup(candidate)}<span class="voice-pick__body"><span class="voice-pick__name">${escapeHtml(candidate.name)}</span><small>${candidateConfidenceLabel(candidate.confidence)}${candidate.matchedText ? ` · «&nbsp;${escapeHtml(candidate.matchedText)}&nbsp;»` : ""}</small></span><em>Valider</em></button>`);
  if (offer) {
    // When nothing in the catalogue is solid, the name the player actually said deserves the first row.
    picks[promoted ? "unshift" : "push"](`<button type="button" role="listitem" class="voice-pick voice-pick--raw ${promoted ? "voice-pick--lead" : ""}" data-voice-validate="raw">${portraitMarkup({ name: offer.name })}<span class="voice-pick__body"><span class="voice-pick__name">${escapeHtml(offer.name)}</span><small>${offer.known ? "entendu tel quel" : "hors catalogue · soumis au vote"}</small></span><em>Valider</em></button>`);
  }
  return `<div class="voice-picks" role="list">${picks.join("")}</div>${offer && !offer.known ? `<button type="button" class="button button--text voice-fix" data-voice-fix="${escapeHtml(offer.name)}">Corriger l’orthographe</button>` : ""}`;
}

function voicePlayerSection(player, index, activePlayer) {
  const active = player.id === activePlayer.id;
  const entry = lastVoiceEntryFor(player.id);
  const seconds = state.game.config.turnSeconds ? (state.timeLeft ?? state.game.config.turnSeconds) : null;
  const timer = active ? (seconds === null ? "∞" : `${seconds}s`) : "—";
  const heard = state.voice.turn.buffer.heard().slice(-2).map((line) => escapeHtml(line.transcript)).join(" · ");
  const flash = state.voice.flash;
  const struck = flash?.strikeId === player.id;
  const strike = struck
    ? `<p class="voice-strike"><b>${escapeHtml(player.name)}</b> ${escapeHtml(flash.reason.toLocaleLowerCase("fr"))}<small>${flash.remaining > 0 ? `${flash.remaining} vie${flash.remaining > 1 ? "s" : ""} restante${flash.remaining > 1 ? "s" : ""}` : "éliminé"}</small></p>`
    : "";
  const body = active
    ? `${strike}${voicePickListMarkup()}${heard ? `<p class="voice-heard">Entendu : ${heard}</p>` : ""}`
    : entry
      ? `${strike}<span class="slug">Dernier nom validé</span><div class="voice-validated">${portraitMarkup({ name: entry.actorName })}<strong>${escapeHtml(entry.actorName)}</strong></div>${state.pending && entry.playerId === state.pending.playerId ? `<p class="voice-correct">Mauvaise identité ? Corrigez avant la décision.</p>${voiceCandidateList(entry)}` : ""}`
      : strike;
  // The clock belongs on the name row: an inactive seat has no countdown to show, and giving it a line of its own
  // cost a row on both seats to display a dash.
  const clock = active
    ? `<span class="voice-clock ${seconds !== null && seconds <= 5 ? "voice-clock--urgent" : ""}"><span>${timer}</span></span>`
    : "";
  return `<section class="voice-player voice-player--${index + 1} ${active ? "voice-player--active" : ""} ${struck ? "voice-player--struck" : ""} ${flash?.toId === player.id ? "voice-player--taking" : ""}" data-voice-panel="${escapeHtml(player.id)}" aria-label="${escapeHtml(player.name)}${active ? ", à vous de jouer" : ", en attente"}"><div class="voice-player__head"><h2><i class="voice-seat" aria-hidden="true">${index === 1 ? "II" : "I"}</i>${escapeHtml(player.name)}</h2>${clock}${livesMarkup(player.lives, true, { dying: struck })}</div><div class="voice-detection">${body}</div></section>`;
}

function voiceChainMarkup() {
  const chain = state.game.chain.slice(-5);
  if (!chain.length) return `<p class="voice-chain voice-chain--empty">La chaîne est vide : le premier nom validé l’ouvre.</p>`;
  return `<p class="voice-chain"><span class="slug">Chaîne ${state.game.chain.length}</span>${state.game.chain.length > chain.length ? "<span>…</span>" : ""}${chain.map((actor) => `<span>${escapeHtml(actor)}</span>`).join("")}${state.pending ? `<span class="voice-chain__pending">${escapeHtml(state.pending.proposedActor)} ?</span>` : ""}</p>`;
}

function voiceStageMarkup() {
  const activePlayer = voiceActivePlayer();
  const players = state.game.players;
  const buzzerReady = Boolean(state.pending && state.game.config.allowBluffChallenge);
  const live = state.voice.interim || state.voice.verdict || (state.pending ? "Laissez passer en parlant, ou buzzez." : "Dites un nom, puis touchez-le.");
  const center = `<div class="voice-center"><div class="voice-wave ${state.voice.listening ? "voice-wave--on" : ""}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p data-voice-live aria-live="polite">${escapeHtml(live)}</p><button class="voice-buzzer" data-voice-buzzer ${buzzerReady ? "" : "disabled"}><span>BLUFF</span><small>${buzzerReady ? "Interrompre et vérifier" : "Après une proposition"}</small></button>${state.voice.supported ? `<button class="button button--ghost voice-mic" data-voice-toggle>${state.voice.consent ? "Pause micro" : "Activer le micro"}</button>` : `<p class="voice-error">Reconnaissance vocale indisponible. La saisie de secours reste jouable.</p>`}${voiceTurnCandidates().length ? `<button class="button button--text voice-clear" data-voice-clear>Effacer</button>` : ""}${state.voice.error ? `<p class="voice-error" role="alert">${escapeHtml(state.voice.error)}</p>` : ""}</div>`;
  return `${voicePlayerSection(players[0], 0, activePlayer)}${center}${voicePlayerSection(players[1], 1, activePlayer)}`;
}

function voiceReviewMarkup() {
  const review = state.voice.review;
  const left = review?.left;
  const right = review?.right;
  const decision = review?.verification
    ? `${verificationPanelMarkup(review.verification)}<div class="decision-grid decision-grid--var"><button class="button button--gold" data-voice-var-valid>Le lien est valide</button><button class="button button--red" data-voice-var-invalid>Bluff confirmé</button><button class="button button--ghost" data-voice-var-pass>Laisser passer sans trancher</button></div>`
    : `<div class="decision-grid"><button class="button button--ghost" data-cancel-voice-review ${review?.checking ? "disabled" : ""}>Reprendre l’écoute</button><button class="button button--red" data-resolve-voice-review ${review?.checking ? "disabled" : ""}>${review?.checking ? "Consultation…" : "Vérifier le bluff"}</button></div>`;
  return shell(`<section class="voice-review">
    <span class="stamp stamp--rouge">Buzzer bluff</span>
    <h1 class="marquee">Qu’avez-vous vraiment dit&nbsp;?</h1>
    <p class="prose">Sélectionnez les deux dernières identités, puis laissez le moteur vérifier la liaison.</p>
    <div class="voice-review__grid">
      <article><small>Nom précédent · ${escapeHtml(left?.playerName ?? "Joueur")}</small><strong>${escapeHtml(left?.transcript ?? "")}</strong>${voiceCandidateList(left, { review: true, side: "left" })}</article>
      <span class="voice-review__link" aria-hidden="true">ET</span>
      <article><small>Nom proposé · ${escapeHtml(right?.playerName ?? "Joueur")}</small><strong>${escapeHtml(right?.transcript ?? "")}</strong>${voiceCandidateList(right, { review: true, side: "right" })}</article>
    </div>
    ${state.voice.error ? `<p class="voice-error" role="alert">${escapeHtml(state.voice.error)}</p>` : ""}
    ${review?.refusal ? `<p class="voice-error" role="status">${escapeHtml(review.refusal)} Le nom précédent reste tel quel; la vérification se poursuit.</p>` : ""}
    <div class="screen__foot">${decision}</div>
  </section>`, { back: "/" });
}

function voiceOutcomeMarkup() {
  const outcome = state.voice.outcome;
  const struck = outcome.struck;
  const reason = outcome.challenged
    ? (outcome.valid ? "Le buzz était injustifié" : "Le bluff est démasqué")
    : "Coup laissé passer sans décision";
  const films = outcome.valid && outcome.films.length
    ? `<div class="stub film-proof"><span class="slug slug--ambre">Film${outcome.films.length > 1 ? "s" : ""} commun${outcome.films.length > 1 ? "s" : ""}</span><ul>${outcome.films.map((film) => `<li>${escapeHtml(film)}</li>`).join("")}</ul></div>`
    : "";
  const penalty = struck
    ? `<p class="voice-outcome__penalty"><b>${escapeHtml(struck.name)}</b> perd une vie · ${struck.lives > 0 ? `${struck.lives} restante${struck.lives > 1 ? "s" : ""}` : "éliminé"}</p>`
    : "";
  return shell(`<section class="screen voice-outcome">
    <span class="stamp verdict ${outcome.valid ? "stamp--vert verdict--valid" : "stamp--rouge verdict--invalid"}">${outcome.valid ? "Liaison valide" : "Aucune liaison"}</span>
    <div class="screen__spacer screen__spacer--half"></div>
    <p class="connection">${escapeHtml(outcome.previous ?? "")} <span aria-hidden="true">—</span> <em>${escapeHtml(outcome.proposed)}</em></p>
    <p class="reveal-note">${escapeHtml(reason)}${outcome.manual ? " · décision rendue par la table" : ""}</p>
    ${films}
    ${penalty}
    ${outcome.verification ? verificationCascadeMarkup(outcome.verification) : ""}
    <div class="screen__spacer"></div>
    <div class="screen__foot">
      <button class="button button--gold button--wide" data-voice-outcome-continue>${outcome.finished ? "Voir le générique" : "Continuer"} <span aria-hidden="true">→</span></button>
    </div>
  </section>`, { back: "/" });
}

export function voiceMarkup() {
  if (state.voice.outcome) return voiceOutcomeMarkup();
  if (state.voice.review) return voiceReviewMarkup();
  syncVoiceTurn();
  const listeningLabel = state.voice.listening ? "Écoute active" : state.voice.consent ? "Démarrage du micro…" : "Micro en pause";
  return shell(`<section class="voice-page">
    <div class="voice-status">
      <span class="voice-listening ${state.voice.listening ? "voice-listening--on" : ""}"><i aria-hidden="true"></i>${listeningLabel}</span>
      <span data-catalog-label>${escapeHtml(catalogStatusLabel())}</span>
    </div>
    <div class="voice-stage" data-voice-stage data-voice-turn="${escapeHtml(voiceActivePlayer().name)}">${voiceStageMarkup()}</div>
    ${voiceChainMarkup()}
    <details class="voice-manual" data-voice-manual ${state.voice.manualOpen ? "open" : ""}>
      <summary>Correction / saisie de secours</summary>
      <form data-voice-manual-form>
        <label class="slug" for="voice-manual-input">Nom entendu pour ${escapeHtml(voiceActivePlayer().name)}</label>
        <div><input id="voice-manual-input" class="field" autocomplete="off" placeholder="Nom de l’artiste"><button class="button button--gold" type="submit">Détecter</button></div>
      </form>
    </details>
  </section>`, { back: "/" });
}

/* -----------------------------------------------------------------------------
   Session
   -------------------------------------------------------------------------- */

function ensureVoiceSession() {
  if (state.voice.session) return state.voice.session;
  state.voice.session = createSpeechSession({
    scope: window,
    lang: "fr-FR",
    onTranscript(event) {
      ingestVoiceUtterance(event);
    },
    onState(event) {
      state.voice.listening = event.listening;
      if (event.listening) ensureVoiceTimer();
      document.querySelector(".voice-listening")?.classList.toggle("voice-listening--on", event.listening);
    },
    onError(event) {
      // A continuous recogniser reports silence and restarts constantly; only real blockers deserve a message.
      if (event.transient && !event.terminal) return;
      state.voice.error = event.code === "not-allowed"
        ? "Accès au micro refusé. Autorisez-le dans le navigateur ou utilisez la saisie de secours."
        : `Micro indisponible (${event.code}).`;
      if (event.terminal) state.voice.consent = false;
      renderRoute();
    },
  });
  return state.voice.session;
}

export function startVoiceSession() {
  state.voice.consent = true;
  state.voice.error = null;
  resolver().warm();
  const started = ensureVoiceSession().start();
  if (!started) state.voice.error = "Le micro n’a pas pu démarrer. La saisie de secours reste disponible.";
}

export function stopVoiceSession({ destroy = true } = {}) {
  if (!state.voice) return;
  if (destroy) state.voice.session?.destroy();
  else state.voice.session?.stop();
  if (destroy) state.voice.session = null;
  state.voice.listening = false;
  state.voice.consent = false;
  stopTimer();
}

/* -----------------------------------------------------------------------------
   Turn transitions
   -------------------------------------------------------------------------- */

function voiceSnapshot() {
  return {
    activeId: voiceActivePlayer().id,
    lives: Object.fromEntries(state.game.players.map((player) => [player.id, player.lives])),
  };
}

function strikeReason(game) {
  const turn = game.turns.at(-1);
  if (!turn) return "Vie perdue";
  if (turn.method === "timeout") return "Chrono expiré";
  if (turn.challenged && !turn.accepted) return "Bluff démasqué";
  if (turn.challenged && turn.accepted) return "Buzz injustifié";
  return "Liaison invalide";
}

// One commit costs at most one life — applyResolution strikes the challenger or the proposer, never both — so a
// single flash can carry the whole story: who lost what, why, and whose turn it now is. This is also the moment
// that confirms a validation actually landed, which is why it survived the redesign.
function flashVoiceTransition(before) {
  if (!before || state.game?.config?.mode !== "voice" || state.game.status !== "in-progress") return;
  const after = voiceSnapshot();
  const struck = state.game.players.find((player) => after.lives[player.id] < (before.lives[player.id] ?? 0));
  const turned = after.activeId !== before.activeId;
  if (!struck && !turned) return;
  const nameOf = (id) => state.game.players.find((player) => player.id === id)?.name ?? "";
  const token = (state.voice.flashToken = (state.voice.flashToken ?? 0) + 1);
  state.voice.flash = {
    token,
    at: Date.now(),
    toId: turned ? after.activeId : null,
    strikeId: struck?.id ?? null,
    reason: struck ? strikeReason(state.game) : null,
    remaining: struck ? after.lives[struck.id] : null,
  };
  announceVoice([
    struck ? `${nameOf(struck.id)} perd une vie : ${state.voice.flash.reason.toLocaleLowerCase("fr")}. Il lui reste ${state.voice.flash.remaining}.` : "",
    turned ? `Au tour de ${nameOf(after.activeId)}.` : "",
  ].filter(Boolean).join(" "));
  window.clearTimeout(state.voice.flashTimer);
  state.voice.flashTimer = window.setTimeout(() => {
    if (state.voice?.flash?.token !== token) return;
    state.voice.flash = null;
    // Nothing else clears the verdict line, so it used to show a result from two turns ago.
    state.voice.verdict = null;
    if (path() === "/play") renderRoute();
  }, VOICE_FLASH_MS);
}

function syncVoiceTurn() {
  const active = voiceActivePlayer();
  if (state.voice.turn.playerId === active.id) return false;
  state.voice.turn = createVoiceTurn(active.id);
  state.voice.interim = "";
  state.timeLeft = null;
  return true;
}

// Repainting the stage alone keeps the fallback input, its focus and its open state untouched.
function updateVoiceLive() {
  const stage = document.querySelector("[data-voice-stage]");
  if (!stage || state.voice.review) {
    renderRoute();
    return;
  }
  stage.innerHTML = voiceStageMarkup();
  stage.dataset.voiceTurn = voiceActivePlayer().name;
  refreshCatalogLabel();
}

/* -----------------------------------------------------------------------------
   Ingestion and validation
   -------------------------------------------------------------------------- */

// Listening never changes the game: it only feeds the pool of propositions for the player whose turn it is.
async function ingestVoiceUtterance({ id, transcript, alternatives = [], final = false }) {
  const spoken = String(transcript ?? "").trim();
  if (!spoken || state.voice.review || state.game?.status !== "in-progress") return;
  syncVoiceTurn();
  const turn = state.voice.turn;
  state.voice.interim = final ? "" : spoken;
  const readings = (alternatives.length ? alternatives : [{ transcript: spoken, confidence: 1 }]).filter((reading) => reading.transcript);
  const utteranceId = id ?? `manual-${(state.voice.utterances += 1)}`;
  const at = Date.now();
  const local = voiceCandidatesFor(readings);
  // What the phonetic pass heard is on the table before the network is even asked: a remote round trip must never
  // look like a pause. The same utterance id is re-ingested afterwards, so the remote answer joins the pool
  // instead of adding a second reading of one sentence.
  turn.buffer.ingest({ id: utteranceId, transcript: spoken, final, candidates: local.candidates, at });
  updateVoiceLive();
  if (!worthAskingRemote(local, final)) return;
  const combined = await remoteVoiceCandidates(local);
  // The recogniser may have moved on to another turn while the catalogue answered.
  if (!combined || state.voice.turn !== turn) return;
  turn.buffer.ingest({ id: utteranceId, transcript: spoken, final, candidates: combined, at });
  updateVoiceLive();
}

async function validateVoiceCandidate(reference) {
  if (state.voice.processing || state.voice.review || state.game.status !== "in-progress") return;
  const pool = voiceTurnCandidates();
  const offer = reference === "raw" ? offCatalogueOffer() : null;
  const candidate = offer
    ? { id: `spoken:${normalizeText(offer.name)}`, name: offer.name, confidence: 0.35, origin: offer.known ? "local" : "vote", externalIds: {} }
    : (reference === "raw" ? null : pool[Number(reference)]);
  if (!candidate) return;
  state.voice.processing = true;
  state.voice.error = null;
  try {
    const speaker = voiceActivePlayer();
    const before = voiceSnapshot();
    if (state.pending) {
      state.game = resolvePending(state.game, state.pending, { challenged: false });
      state.pending = null;
      // Conceding the previous proposition is a decision of its own: persist it before anything else can fail.
      app.storage.saveCurrent(state.game);
    }
    const active = currentPlayer(state.game);
    if (active.id !== speaker.id) throw new Error("Le tour a changé. Reprenez la proposition.");
    const person = await hydrateVoiceCandidate(candidate);
    // Hydration is a network round trip. The chrono may have run out meanwhile and handed the turn over.
    if (currentPlayer(state.game).id !== speaker.id || state.pending) throw new Error("Le tour a changé pendant la vérification. Reprenez la proposition.");
    const actorName = person?.name ?? candidate.name;
    const result = proposeActor(state.game, actorName, app.database);
    state.voice.entries = [...state.voice.entries, {
      id: globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now()}`,
      playerId: active.id,
      playerName: active.name,
      actorName,
      transcript: candidate.matchedText ?? state.voice.turn.buffer.lastTranscript() ?? actorName,
      candidates: reference === "raw" ? [candidate, ...pool] : (pool.length ? pool : [candidate]),
      selected: reference === "raw" ? 0 : Math.max(0, Number(reference)),
      at: Date.now(),
    }].slice(-12);
    if (result.type === "pending") state.pending = result.pending;
    else state.game = result.game;
    state.voice.verdict = `${active.name} valide ${actorName}`;
    flashVoiceTransition(before);
    syncVoiceTurn();
    app.storage.saveCurrent(state.game);
    queueCreditsRefresh(state.game);
    if (state.game.status === "finished") navigate("/credits");
    else renderRoute();
  } catch (error) {
    state.voice.error = error.message;
    renderRoute();
  } finally {
    state.voice.processing = false;
  }
}

async function selectCurrentVoiceCandidate(entryId, candidateIndex) {
  const entry = state.voice.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry !== state.voice.entries.at(-1) || !state.pending) return;
  // The proposition this correction replaces must still be the one on the table when hydration comes back;
  // otherwise proposeActor would arm a brand new proposition on an already advanced game.
  const armed = state.pending;
  try {
    const candidate = entry.candidates[candidateIndex];
    const person = await hydrateVoiceCandidate(candidate);
    if (state.pending !== armed) {
      state.voice.error = "Trop tard : le tour a changé pendant la correction. Utilisez le buzzer pour rectifier.";
      renderRoute();
      return;
    }
    const result = proposeActor(state.game, person?.name ?? candidate.name, app.database);
    if (result.type !== "pending") return;
    entry.selected = candidateIndex;
    entry.actorName = person?.name ?? candidate.name;
    state.pending = result.pending;
    state.voice.verdict = `${entry.playerName} corrige en ${entry.actorName}`;
    renderRoute();
  } catch (error) {
    state.voice.error = error.message;
    renderRoute();
  }
}

/* -----------------------------------------------------------------------------
   The buzzer review
   -------------------------------------------------------------------------- */

function openVoiceReview() {
  if (!state.pending) return;
  stopVoiceSession({ destroy: false });
  // A reloaded page has no spoken history: the pending move and the chain still describe both sides.
  const lastEntry = state.voice.entries.at(-1);
  const currentEntry = (lastEntry && normalizeText(lastEntry.actorName ?? "") === normalizeText(state.pending.proposedActor)) ? lastEntry : {
    id: "pending-proposal",
    playerId: state.pending.playerId,
    playerName: state.game.players.find((player) => player.id === state.pending.playerId)?.name ?? "Joueur",
    actorName: state.pending.proposedActor,
    transcript: state.pending.proposedActor,
    candidates: [{ id: "pending-proposal", name: state.pending.proposedActor, confidence: 1, origin: "chain", externalIds: {} }],
    selected: 0,
  };
  // The left side is whatever the chain actually ends with. Spoken history can hold names that were rejected by a
  // previous bluff and never entered the chain; trusting it here would let the correction overwrite a real link.
  const chainTail = state.game.chain.at(-1);
  const spokenTail = [...state.voice.entries].reverse().find((entry) => normalizeText(entry.actorName ?? "") === normalizeText(chainTail ?? ""));
  const previousEntry = spokenTail ?? {
    id: "chain-previous",
    playerId: state.pending.challengerId,
    playerName: state.game.players.find((player) => player.id === state.pending.challengerId)?.name ?? "Joueur précédent",
    actorName: chainTail,
    transcript: chainTail,
    candidates: [{ id: "chain-previous", name: chainTail, confidence: 1, origin: "chain", externalIds: {} }],
    selected: 0,
  };
  state.voice.review = {
    left: previousEntry,
    right: currentEntry,
    selected: { left: previousEntry.selected ?? 0, right: currentEntry?.selected ?? 0 },
  };
  renderRoute();
}

function completeVoiceReview(game, pending, { challenged }) {
  const review = state.voice.review;
  const before = game.chain.length;
  const snapshot = voiceSnapshot();
  state.game = resolvePending(game, pending, { challenged });
  flashVoiceTransition(snapshot);
  if (review) {
    review.left.selected = review.selected.left;
    review.right.selected = review.selected.right;
    review.left.actorName = review.left.candidates?.[review.selected.left]?.name ?? review.left.actorName;
    // A refused proposition never reaches the chain, so its spoken entry must not outlive it either: the next
    // buzzer reads the last entry as the chain tail.
    if (state.game.chain.length === before) state.voice.entries = state.voice.entries.filter((entry) => entry !== review.right);
  }
  state.voice.verdict = null;
  // A buzz is the one moment the table stops to be told something. Announcing it in the status line meant the
  // answer scrolled past, and when the challenge ended the game it was never shown at all — the players had to
  // infer who had been wrong from who had won.
  state.voice.outcome = {
    challenged,
    valid: Boolean(pending.wasValid),
    previous: game.chain.at(-1) ?? null,
    proposed: pending.proposedActor,
    films: pending.sharedFilms ?? [],
    verification: pending.verification ?? null,
    manual: Boolean(pending.manualDecision),
    struck: state.game.players.find((player) => player.lives < (snapshot.lives[player.id] ?? player.lives)) ?? null,
    finished: state.game.status === "finished",
  };
  state.pending = null;
  state.voice.review = null;
  state.timeLeft = null;
  app.storage.saveCurrent(state.game);
  // The reel is rebuilt between turns so the closing roll is ready before the last life is even spent.
  queueCreditsRefresh(state.game);
  renderRoute();
}

async function resolveVoiceReview() {
  const review = state.voice.review;
  if (!review || review.checking) return;
  state.voice.error = null;
  review.checking = true;
  renderRoute();
  try {
    const leftCandidate = review.left.candidates[review.selected.left];
    const rightCandidate = review.right.candidates[review.selected.right];
    const [leftPerson, rightPerson] = await Promise.all([hydrateVoiceCandidate(leftCandidate), hydrateVoiceCandidate(rightCandidate)]);
    // Correcting the previous name is an option; verifying the bluff is the point. A correction the engine
    // refuses — because it would break the link before it — must not strand the players on this screen.
    let corrected = state.game;
    try {
      corrected = replaceLastActor(state.game, leftPerson?.name ?? leftCandidate.name, app.database);
    } catch (refusal) {
      review.refusal = refusal.message;
    }
    const result = proposeActor(corrected, rightPerson?.name ?? rightCandidate.name, app.database);
    if (result.type !== "pending") throw new Error("La liaison à vérifier est incomplète.");
    const pending = await verifyPendingLink(result.game, result.pending);
    if (pending.wasValid) {
      completeVoiceReview(result.game, pending, { challenged: true });
      return;
    }
    review.game = result.game;
    review.verification = pending.verification ?? { verdict: "UNKNOWN", source: "none", films: [], evidence: [] };
    review.checking = false;
    state.pending = pending;
    renderRoute();
  } catch (error) {
    review.checking = false;
    state.voice.error = error.message;
    renderRoute();
  }
}

function resolveVoiceVar(valid, challenged = true) {
  const review = state.voice.review;
  if (!review?.game || !state.pending) return;
  const pending = challenged ? adjudicatePending(state.pending, { valid }) : state.pending;
  completeVoiceReview(review.game, pending, { challenged });
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
    const before = voiceSnapshot();
    if (state.pending) {
      state.game = resolvePending(state.game, state.pending, { challenged: false });
      state.pending = null;
    }
    state.game = resolvePending(state.game, timeoutPending(state.game), { challenged: false });
    state.voice.verdict = "Temps écoulé";
    flashVoiceTransition(before);
    state.timeLeft = null;
    app.storage.saveCurrent(state.game);
    queueCreditsRefresh(state.game);
    if (state.game.status === "finished") navigate("/credits");
    else renderRoute();
  }, 1000);
}

/* -----------------------------------------------------------------------------
   Bindings
   -------------------------------------------------------------------------- */

export function bindVoice() {
  document.querySelector("[data-voice-outcome-continue]")?.addEventListener("click", () => {
    const finished = state.voice.outcome?.finished;
    state.voice.outcome = null;
    if (finished) navigate("/credits");
    else {
      startVoiceSession();
      renderRoute();
    }
  });

  // The stage is repainted on every utterance, so its buttons answer through one delegated listener.
  document.querySelector(".voice-page")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-voice-validate],[data-voice-candidate],[data-voice-toggle],[data-voice-buzzer],[data-voice-clear],[data-voice-fix]");
    if (!target) return;
    if (target.dataset.voiceValidate !== undefined) validateVoiceCandidate(target.dataset.voiceValidate);
    else if (target.dataset.voiceCandidate !== undefined) selectCurrentVoiceCandidate(target.dataset.voiceEntry, Number(target.dataset.voiceCandidate));
    else if (target.dataset.voiceBuzzer !== undefined) openVoiceReview();
    else if (target.dataset.voiceFix !== undefined) {
      // Hand the misheard spelling to the fallback field rather than leaving the player to retype it.
      state.voice.manualOpen = true;
      renderRoute();
      const input = document.querySelector("#voice-manual-input");
      if (input) {
        input.value = target.dataset.voiceFix;
        input.focus();
        input.select();
      }
    } else if (target.dataset.voiceClear !== undefined) {
      state.voice.turn.buffer.clearCandidates();
      state.voice.interim = "";
      updateVoiceLive();
    } else {
      if (state.voice.consent) stopVoiceSession({ destroy: false });
      else startVoiceSession();
      renderRoute();
    }
  });

  // Players without a working microphone live in this panel: it must survive a turn change.
  const manual = document.querySelector("[data-voice-manual]");
  manual?.addEventListener("toggle", () => { state.voice.manualOpen = manual.open; });
  if (state.voice.manualOpen) document.querySelector("#voice-manual-input")?.focus({ preventScroll: true });
  document.querySelector("[data-voice-manual-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#voice-manual-input");
    if (!input?.value.trim()) return;
    ingestVoiceUtterance({ id: `manual-${(state.voice.utterances += 1)}`, transcript: input.value, final: true });
    input.value = "";
  });

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
  document.querySelector("[data-voice-var-valid]")?.addEventListener("click", () => resolveVoiceVar(true));
  document.querySelector("[data-voice-var-invalid]")?.addEventListener("click", () => resolveVoiceVar(false));
  document.querySelector("[data-voice-var-pass]")?.addEventListener("click", () => resolveVoiceVar(false, false));

  ensureVoiceTimer();
}
