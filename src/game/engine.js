import { normalizeText } from "./database.js";
import { DEFAULT_EXTENSIONS, normalizeExtensions } from "./work-kinds.js";

export const GAME_VERSION = 3;
export const MAX_PLAYERS = 10;
export const DEFAULT_CONFIG = Object.freeze({
  themeId: "classic",
  livesPerPlayer: 3,
  turnSeconds: 30,
  allowBluffChallenge: true,
  mode: "classic",
  // Le périmètre des œuvres qui relient deux artistes. Il appartient à la partie et non aux réglages de
  // l'appareil : une sauvegarde rouverte doit se rejouer sous les règles sous lesquelles elle a été jouée.
  extensions: DEFAULT_EXTENSIONS,
});

// Le périmètre demandé par la partie, lisible même sur une sauvegarde antérieure aux extensions — qui n'en porte
// aucune, et se rejoue donc au socle.
export const configExtensions = (game) => normalizeExtensions(game?.config?.extensions);

const clone = (value) => structuredClone(value);
const fallbackId = () => Math.random().toString(36).slice(2, 10);

function playerTemplate(id, name, lives) {
  return {
    id,
    name,
    lives,
    score: 0,
    bluffsAttempted: 0,
    bluffsSucceeded: 0,
    bluffsCaught: 0,
    filmsFound: 0,
    streak: 0,
    bestStreak: 0,
    challengesMade: 0,
    challengesSuccessful: 0,
  };
}

export function createGame({ names, config = {}, random = Math.random, now = Date.now, idFactory = fallbackId } = {}) {
  const cleanNames = [...new Set((names ?? []).map((name) => String(name).trim()).filter(Boolean))].slice(0, MAX_PLAYERS);
  if (cleanNames.length < 2) throw new Error("Une partie nécessite au moins deux joueurs.");
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  mergedConfig.extensions = normalizeExtensions(config.extensions);
  const players = cleanNames.map((name) => playerTemplate(idFactory(), name, mergedConfig.livesPerPlayer));
  return {
    version: GAME_VERSION,
    id: idFactory(),
    startedAt: now(),
    config: mergedConfig,
    players,
    currentPlayerIdx: Math.floor(random() * players.length),
    chain: [],
    turns: [],
    status: "in-progress",
    winnerId: null,
  };
}

export function alivePlayers(game) {
  return game.players.filter((player) => player.lives > 0);
}

export function nextAliveIndex(game, fromIndex) {
  for (let offset = 1; offset <= game.players.length; offset += 1) {
    const index = (fromIndex + offset) % game.players.length;
    if (game.players[index].lives > 0) return index;
  }
  return fromIndex;
}

// Il n'y a volontairement pas de previousAliveIndex : plus rien ne remonte le tour de table. Ses deux seuls
// appelants — proposeActor et timeoutPending — y désignaient le challenger, et c'est précisément l'erreur que
// ce sens de lecture a causée.

export function currentPlayer(game) {
  return game.players[game.currentPlayerIdx];
}

function resolveWinner(game) {
  const survivors = alivePlayers(game);
  if (survivors.length > 1) return false;
  game.status = "finished";
  game.winnerId = survivors[0]?.id ?? null;
  return true;
}

function applyResolution(game, pending, { challenged }) {
  const next = clone(game);
  const proposer = next.players[next.currentPlayerIdx];
  const challenger = next.players.find((player) => player.id === pending.challengerId);
  const valid = Boolean(pending.wasValid);
  // Without bluff challenges the automatic check is the sole referee: an unchallenged move never "gets away", only a
  // proven link stands. With challenges, an unchallenged proposition is accepted as before.
  const acceptedAsMove = !pending.forceInvalid && (valid || (!challenged && !pending.autoVerify));
  const attemptedBluff = !valid;

  if (pending.opening) {
    next.chain.push(pending.proposedActor);
    next.turns.push({ ...pending, challenged: false, accepted: true, wasBluff: false });
    next.currentPlayerIdx = nextAliveIndex(next, next.currentPlayerIdx);
    return next;
  }

  if (challenged && challenger) {
    challenger.challengesMade += 1;
  }
  // An unproven link outside the bluff game is a plain invalid move, not a bluff attempt: it never touches the
  // bluff counters.
  if (attemptedBluff && !pending.autoVerify) proposer.bluffsAttempted += 1;

  if (acceptedAsMove) {
    next.chain.push(pending.proposedActor);
    proposer.filmsFound += pending.sharedFilms.length || 1;
    proposer.score += challenged && valid ? 2 : 1;
    proposer.streak += 1;
    proposer.bestStreak = Math.max(proposer.bestStreak, proposer.streak);
    if (attemptedBluff) proposer.bluffsSucceeded += 1;
    if (challenged && valid && challenger) {
      challenger.lives = Math.max(0, challenger.lives - 1);
    }
  } else {
    proposer.streak = 0;
    proposer.lives = Math.max(0, proposer.lives - 1);
    if (challenged) {
      proposer.bluffsCaught += 1;
      if (challenger) {
        challenger.challengesSuccessful += 1;
        challenger.score += 1;
      }
    }
  }

  next.turns.push({
    ...pending,
    challenged,
    accepted: acceptedAsMove,
    // Hors du jeu de bluff, une liaison non prouvée est un maillon invalide, pas un bluff : le générique et ses
    // compteurs ne doivent pas l'y confondre.
    wasBluff: attemptedBluff && !pending.autoVerify,
  });

  if (!resolveWinner(next)) next.currentPlayerIdx = nextAliveIndex(next, next.currentPlayerIdx);
  return next;
}

export function proposeActor(game, actorName, database) {
  if (!game || game.status !== "in-progress") throw new Error("La partie est terminée.");
  const proposedActor = String(actorName ?? "").trim();
  if (!proposedActor) throw new Error("Choisis un acteur.");
  const used = new Set(game.chain.map(normalizeText));
  if (used.has(normalizeText(proposedActor))) throw new Error("Cet acteur a déjà été utilisé.");

  const previousActor = game.chain.at(-1) ?? null;
  // Le défi appartient au joueur suivant, pas au précédent. Une fois A posé par le joueur 1 et B par le
  // joueur 2, c'est le joueur 3 — celui qui doit accrocher C à B — qui arbitre : ou il crie au bluff sur la
  // liaison A–B, ou il l'accepte et enchaîne. À deux joueurs les deux lectures désignent la même personne,
  // ce qui a laissé passer l'erreur ; au-delà, elle donnait la décision à quelqu'un qui avait déjà joué.
  const challenger = database && previousActor ? game.players[nextAliveIndex(game, game.currentPlayerIdx)] : null;
  const sharedFilms = previousActor ? database.sharedFilms(previousActor, proposedActor, game.config.themeId, { extensions: configExtensions(game) }) : [];
  const knownPair = Boolean(previousActor && database.hasActor(previousActor, game.config.themeId) && database.hasActor(proposedActor, game.config.themeId));
  const pending = {
    index: game.turns.length,
    playerId: currentPlayer(game).id,
    challengerId: challenger?.id ?? null,
    proposedActor,
    sharedFilms,
    wasValid: previousActor ? sharedFilms.length > 0 : true,
    method: previousActor && knownPair ? "database" : "vote",
    opening: !previousActor,
  };

  if (!previousActor) return { type: "resolved", game: applyResolution(game, pending, { challenged: false }), pending: null };
  if (!game.config.allowBluffChallenge) {
    // Le vocal garde son acceptation directe : son buzzer central tient lieu de défi et il n'a pas d'écran VAR de
    // repli. En classique en revanche, couper les défis de bluff ne doit pas laisser passer les liaisons : chaque
    // maillon est vérifié automatiquement, et le coup reste en attente le temps de cette vérification.
    if (game.config.mode === "voice") return { type: "resolved", game: applyResolution(game, pending, { challenged: false }), pending: null };
    pending.autoVerify = true;
  }
  return { type: "pending", game, pending };
}

export function resolvePending(game, pending, { challenged = false } = {}) {
  if (!pending) throw new Error("Aucun coup en attente.");
  return applyResolution(game, pending, { challenged });
}

export function applyLinkVerification(pending, verification) {
  if (!pending) throw new Error("Aucun coup en attente.");
  const next = clone(pending);
  next.verification = clone(verification ?? { verdict: "UNKNOWN", source: "none", films: [], evidence: [] });
  if (verification?.verdict === "CONFIRMED") {
    next.wasValid = true;
    next.forceInvalid = false;
    next.sharedFilms = [...new Set((verification.films ?? []).map((film) => typeof film === "string" ? film : film?.title).filter(Boolean))];
    next.method = verification.source ?? "external-verification";
  }
  return next;
}

export function adjudicatePending(pending, { valid, source = "var-human", films = null } = {}) {
  if (!pending) throw new Error("Aucun coup en attente.");
  if (typeof valid !== "boolean") throw new Error("La décision VAR doit être explicite.");
  const next = clone(pending);
  next.wasValid = valid;
  next.forceInvalid = false;
  next.method = source;
  next.manualDecision = true;
  const evidenceFilms = films ?? next.verification?.films ?? [];
  next.sharedFilms = valid
    ? [...new Set(evidenceFilms.map((film) => typeof film === "string" ? film : film?.title).filter(Boolean))]
    : [];
  return next;
}

export function timeoutTurn(game) {
  return applyResolution(game, timeoutPending(game), { challenged: false });
}

export function timeoutPending(game) {
  const proposer = currentPlayer(game);
  // Aucun challenger : rien n'a été proposé, donc personne n'a eu à trancher. Le champ portait jusqu'ici le
  // joueur précédent, et le passer au suivant avec proposeActor aurait été pire — il aurait crédité une
  // occasion de buzzer imaginaire à celui qui prend justement la main. Rien d'autre ne le lit sur un chrono
  // expiré : applyResolution ne s'en sert que sur un coup contesté, et un timeout se règle toujours sans défi.
  return {
    index: game.turns.length,
    playerId: proposer.id,
    challengerId: null,
    proposedActor: "(temps écoulé)",
    sharedFilms: [],
    wasValid: false,
    method: "timeout",
    forceInvalid: true,
  };
}

export function replaceLastActor(game, actorName, database, { now = Date.now } = {}) {
  if (!game?.chain?.length) throw new Error("La chaîne est encore vide.");
  if (game.status !== "in-progress") throw new Error("La partie est terminée.");
  const actor = database?.findActor(actorName, game.config.themeId);
  const replacement = actor?.name ?? String(actorName ?? "").trim();
  if (!replacement) throw new Error("Choisis une identité pour la correction.");
  const usedBeforeLast = new Set(game.chain.slice(0, -1).map(normalizeText));
  if (usedBeforeLast.has(normalizeText(replacement))) throw new Error("Cet acteur a déjà été utilisé dans la chaîne.");
  const next = clone(game);
  const previousActor = next.chain.at(-2) ?? null;
  for (let index = next.turns.length - 1; index >= 0; index -= 1) {
    const turn = next.turns[index];
    if (!turn.accepted) continue;
    const sharedFilms = previousActor ? database?.sharedFilms(previousActor, replacement, next.config.themeId, { extensions: configExtensions(next) }) ?? [] : [];
    const knownPair = previousActor && database?.hasActor(previousActor, next.config.themeId) && database?.hasActor(replacement, next.config.themeId);
    if (knownPair && !sharedFilms.length) throw new Error("Cette correction casserait la liaison précédente.");
    const proposer = next.players.find((player) => player.id === turn.playerId);
    if (previousActor && proposer) {
      const previousCredit = turn.sharedFilms?.length || 1;
      const correctedCredit = sharedFilms.length || 1;
      proposer.filmsFound = Math.max(0, proposer.filmsFound - previousCredit + correctedCredit);
    }
    turn.proposedActor = replacement;
    turn.sharedFilms = sharedFilms;
    turn.wasValid = previousActor ? sharedFilms.length > 0 : true;
    turn.method = "voice-correction";
    turn.correctedAt = now();
    break;
  }
  next.chain[next.chain.length - 1] = replacement;
  return next;
}

export function serializeGame(game) {
  return clone(game);
}
