import { normalizeText } from "./database.js";

export const GAME_VERSION = 2;
export const MAX_PLAYERS = 10;
export const DEFAULT_CONFIG = Object.freeze({
  themeId: "classic",
  livesPerPlayer: 3,
  turnSeconds: 30,
  allowBluffChallenge: true,
});

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

export function previousAliveIndex(game, fromIndex) {
  for (let offset = 1; offset <= game.players.length; offset += 1) {
    const index = (fromIndex - offset + game.players.length) % game.players.length;
    if (game.players[index].lives > 0) return index;
  }
  return fromIndex;
}

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
  const acceptedAsMove = !pending.forceInvalid && (valid || !challenged);
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
  if (attemptedBluff) proposer.bluffsAttempted += 1;

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
    wasBluff: attemptedBluff,
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
  const challenger = database && previousActor ? game.players[previousAliveIndex(game, game.currentPlayerIdx)] : null;
  const sharedFilms = previousActor ? database.sharedFilms(previousActor, proposedActor, game.config.themeId) : [];
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
  if (!game.config.allowBluffChallenge) return { type: "resolved", game: applyResolution(game, pending, { challenged: false }), pending: null };
  return { type: "pending", game, pending };
}

export function resolvePending(game, pending, { challenged = false } = {}) {
  if (!pending) throw new Error("Aucun coup en attente.");
  return applyResolution(game, pending, { challenged });
}

export function timeoutTurn(game) {
  return applyResolution(game, timeoutPending(game), { challenged: false });
}

export function timeoutPending(game) {
  const proposer = currentPlayer(game);
  const challenger = game.chain.length ? game.players[previousAliveIndex(game, game.currentPlayerIdx)] : null;
  return {
    index: game.turns.length,
    playerId: proposer.id,
    challengerId: challenger?.id ?? null,
    proposedActor: "(temps écoulé)",
    sharedFilms: [],
    wasValid: false,
    method: "timeout",
    forceInvalid: true,
  };
}

export function serializeGame(game) {
  return clone(game);
}
