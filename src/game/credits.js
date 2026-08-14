// The reel that plays before the scores.
//
// A finished game already knows everything that happened — every proposition, every buzz, every verdict sits in
// game.turns — but nothing ever handed it back to the table. The one thing the players never learn is the most
// interesting: a bluff that was accepted stays a secret for ever, because the interface has no reason to look the
// link up again once the turn is over. This module reads the log once and returns the credits: the cast, the chain
// with the films that actually hold it together, the artists who were named but never retained, and the bluff
// ledger — the ones that were caught, and the ones that slipped through.
//
// It is pure, synchronous and cheap on purpose. The interface rebuilds it in the background after every turn, so
// the roll is ready the instant the last life goes and no player ever waits for it.

import { normalizeText } from "./database.js";
import { normalizeExtensions } from "./work-kinds.js";

// The engine writes this in place of a name when the chrono wins the turn; it is a stage direction, not an artist.
const TIMEOUT_ACTOR = "(temps écoulé)";

const filmTitle = (film) => (typeof film === "string" ? film : film?.title ?? null);

const uniqueTitles = (values) => [...new Set((values ?? []).map(filmTitle).filter(Boolean))];

// Everything the roll depends on, in one string: a rebuild is only worth doing when one of these moved. The
// correction stamp is in there because a voice correction rewrites the last turn without adding one, and the end
// stamp because it is written after the last turn — a roll built before it would lose the running time.
export function creditsSignature(game) {
  if (!game) return "none";
  return [
    game.id ?? "sans-id",
    game.status ?? "unknown",
    game.turns?.length ?? 0,
    game.chain?.length ?? 0,
    game.turns?.at(-1)?.correctedAt ?? 0,
    game.finishedAt ?? 0,
  ].join(":");
}

// Seven ways a turn can end, and the roll tells them apart because each one deserves a different card.
function sceneKind(turn) {
  if (turn.opening) return "opening";
  if (turn.method === "timeout") return "timeout";
  if (turn.accepted) {
    if (turn.wasBluff) return "bluff-slipped";
    return turn.challenged ? "challenge-failed" : "link";
  }
  if (turn.wasBluff && turn.challenged) return "bluff-unmasked";
  return "broken-link";
}

function emptyTally() {
  return {
    links: 0,
    bluffsAttempted: 0,
    bluffsSlipped: 0,
    bluffsUnmasked: 0,
    challengesMade: 0,
    challengesWon: 0,
    challengesLost: 0,
    timeouts: 0,
    livesLost: 0,
    eliminatedAt: null,
  };
}

// A closing card names its cast by what they did, the way a real one names a stunt team. Titles are awarded once,
// in billing order on a tie, so two players never share a line and nobody is left without one.
function assignRoles(cast) {
  for (const member of cast) if (member.winner) member.role = "survivor";
  const award = (key, role, minimum = 1) => {
    const top = Math.max(0, ...cast.map((member) => member[key] ?? 0));
    if (top < minimum) return;
    const winner = cast.find((member) => !member.role && (member[key] ?? 0) === top);
    if (winner) winner.role = role;
  };
  award("bluffsSlipped", "illusionist");
  award("challengesWon", "editor");
  award("filmsFound", "archivist");
  award("bluffsUnmasked", "understudy");
  award("bestStreak", "lead", 2);
  for (const member of cast) member.role ??= "supporting";
  return cast;
}

export function buildCredits(game, { database = null } = {}) {
  if (!game) return null;
  const themeId = game.config?.themeId ?? "classic";
  // Le générique interroge de nouveau les archives sur les liaisons prises au vote : il doit le faire sous le
  // périmètre de la partie, sinon il « retrouverait » après coup l'émission que le jeu avait refusée pendant.
  const extensions = normalizeExtensions(game.config?.extensions);
  const capacity = game.config?.livesPerPlayer ?? 3;
  const players = game.players ?? [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const nameOf = (id) => (id ? byId.get(id)?.name ?? null : null);

  const lives = new Map(players.map((player) => [player.id, capacity]));
  const tallies = new Map(players.map((player) => [player.id, emptyTally()]));

  const scenes = [];
  const reel = [];
  const guests = [];
  const seenGuests = new Set();
  let previousActor = null;

  for (const [index, turn] of (game.turns ?? []).entries()) {
    const act = index + 1;
    const kind = sceneKind(turn);
    const stats = tallies.get(turn.playerId);
    const challengerId = turn.challenged ? turn.challengerId ?? null : null;
    const challengerStats = challengerId ? tallies.get(challengerId) : null;

    // Nothing records a lost life turn by turn, but the rule that spends one is the same rule that accepted or
    // refused the move, so the ledger is rebuilt rather than guessed.
    let struckId = null;
    if (!turn.opening) {
      if (!turn.accepted) struckId = turn.playerId;
      else if (turn.challenged && turn.wasValid) struckId = turn.challengerId ?? null;
    }
    if (struckId && lives.has(struckId)) {
      lives.set(struckId, Math.max(0, lives.get(struckId) - 1));
      const struckStats = tallies.get(struckId);
      if (struckStats) {
        struckStats.livesLost += 1;
        if (lives.get(struckId) === 0 && struckStats.eliminatedAt === null) struckStats.eliminatedAt = act;
      }
    }

    // The turn keeps whatever proof it was decided on. When it has none — a link taken on a vote, or a bluff that
    // was never questioned — the archive is asked again now, because the catalogue may have learnt the pair since.
    const recorded = uniqueTitles(turn.sharedFilms?.length ? turn.sharedFilms : turn.verification?.films);
    let archived = [];
    if (!recorded.length && previousActor && database && turn.proposedActor && turn.proposedActor !== TIMEOUT_ACTOR) {
      try {
        archived = uniqueTitles(database.sharedFilms(previousActor, turn.proposedActor, themeId, { extensions }));
      } catch {
        archived = [];
      }
    }
    const films = recorded.length ? recorded : archived;

    const scene = {
      act,
      kind,
      playerId: turn.playerId ?? null,
      playerName: nameOf(turn.playerId),
      challengerId,
      challengerName: nameOf(challengerId),
      actor: turn.proposedActor ?? null,
      from: previousActor,
      films,
      // The chain held after all: the engine judged on a catalogue that did not know the pair yet.
      lateEvidence: !recorded.length && archived.length > 0,
      method: turn.method ?? null,
      verdict: turn.verification?.verdict ?? null,
      source: turn.verification?.source ?? null,
      manual: Boolean(turn.manualDecision),
      challenged: Boolean(turn.challenged),
      accepted: Boolean(turn.accepted),
      bluff: Boolean(turn.wasBluff),
      struckId,
      struckName: nameOf(struckId),
      livesLeft: struckId ? lives.get(struckId) ?? 0 : null,
      eliminated: Boolean(struckId && lives.get(struckId) === 0),
    };
    scenes.push(scene);

    if (stats) {
      if (kind === "timeout") stats.timeouts += 1;
      if (turn.wasBluff && !turn.opening) stats.bluffsAttempted += 1;
      if (kind === "bluff-slipped") stats.bluffsSlipped += 1;
      if (kind === "bluff-unmasked") stats.bluffsUnmasked += 1;
      if (turn.accepted && !turn.opening) stats.links += 1;
    }
    if (challengerStats) {
      challengerStats.challengesMade += 1;
      if (turn.accepted) challengerStats.challengesLost += 1;
      else challengerStats.challengesWon += 1;
    }

    if (turn.accepted) {
      reel.push({
        position: reel.length,
        from: previousActor,
        actor: turn.proposedActor,
        films,
        lateEvidence: scene.lateEvidence,
        bluff: Boolean(turn.wasBluff),
        // A bluff the archives later contradict: the player was right without knowing it.
        redeemed: Boolean(turn.wasBluff && films.length > 0),
        challenged: Boolean(turn.challenged),
        act,
        playerId: turn.playerId ?? null,
        playerName: nameOf(turn.playerId),
        method: turn.method ?? null,
      });
      previousActor = turn.proposedActor;
    } else if (turn.proposedActor && turn.proposedActor !== TIMEOUT_ACTOR) {
      const key = normalizeText(turn.proposedActor);
      if (!seenGuests.has(key)) {
        seenGuests.add(key);
        guests.push({
          name: turn.proposedActor,
          act,
          kind,
          playerId: turn.playerId ?? null,
          playerName: nameOf(turn.playerId),
          challengerName: nameOf(challengerId),
          from: scene.from,
        });
      }
    }
  }

  const cast = assignRoles(players.map((player, index) => {
    const stats = tallies.get(player.id) ?? emptyTally();
    return {
      id: player.id,
      name: player.name,
      billing: index + 1,
      winner: player.id === game.winnerId,
      lives: player.lives,
      capacity,
      score: player.score ?? 0,
      filmsFound: player.filmsFound ?? 0,
      bestStreak: player.bestStreak ?? 0,
      role: null,
      ...stats,
    };
  }));

  const distinctFilms = new Set(reel.flatMap((entry) => entry.films));
  const tally = {
    acts: scenes.length,
    actors: reel.length,
    links: reel.filter((entry) => entry.from).length,
    films: distinctFilms.size,
    bluffsAttempted: scenes.filter((scene) => scene.bluff && scene.kind !== "opening").length,
    bluffsSlipped: scenes.filter((scene) => scene.kind === "bluff-slipped").length,
    bluffsUnmasked: scenes.filter((scene) => scene.kind === "bluff-unmasked").length,
    challenges: scenes.filter((scene) => scene.challenged).length,
    challengesRight: scenes.filter((scene) => scene.challenged && !scene.accepted).length,
    challengesWrong: scenes.filter((scene) => scene.challenged && scene.accepted).length,
    timeouts: scenes.filter((scene) => scene.kind === "timeout").length,
    varDecisions: scenes.filter((scene) => scene.manual).length,
    livesLost: scenes.filter((scene) => scene.struckId).length,
    longestStreak: Math.max(0, ...players.map((player) => player.bestStreak ?? 0)),
  };

  const startedAt = game.startedAt ?? null;
  const finishedAt = game.finishedAt ?? null;

  return {
    signature: creditsSignature(game),
    gameId: game.id ?? null,
    status: game.status ?? "in-progress",
    mode: game.config?.mode ?? "classic",
    winnerId: game.winnerId ?? null,
    winnerName: nameOf(game.winnerId),
    startedAt,
    finishedAt,
    durationMs: startedAt && finishedAt && finishedAt > startedAt ? finishedAt - startedAt : null,
    opening: reel[0]?.actor ?? null,
    closing: reel.at(-1)?.actor ?? null,
    cast,
    reel,
    guests,
    scenes,
    bluffs: {
      slipped: scenes.filter((scene) => scene.kind === "bluff-slipped"),
      unmasked: scenes.filter((scene) => scene.kind === "bluff-unmasked"),
      falseAlarms: scenes.filter((scene) => scene.kind === "challenge-failed"),
    },
    tally,
  };
}
