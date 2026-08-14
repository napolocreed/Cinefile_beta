// Ce que les compteurs à vie ne peuvent pas savoir.
//
// Un profil ne retient que des nombres : il ne sait pas quel acteur revient sans arrêt, ni qui le bat. L'historique,
// lui, garde cinquante parties entières — chaînes, tours, noms. Ce module le lit une fois et range ce qu'il y trouve
// par joueur. Tout ce qui en sort porte donc une limite : « sur les cinquante dernières parties », jamais « depuis
// toujours ». C'est dit dans les libellés, pas seulement ici.

import { normalizeText } from "./identity.js";

// Le moteur écrit ceci à la place d'un nom quand le chrono gagne le tour : une didascalie, pas un artiste.
const TIMEOUT_ACTOR = "(temps écoulé)";

// Une partie laissée ouverte une nuit et reprise au matin n'est pas une séance de dix heures.
export const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

// Quatre séances plutôt que vingt-quatre heures : sur dix parties, un histogramme horaire ne dit rien.
export const SLOTS = ["Matinée", "Après-midi", "Soirée", "Séance de minuit"];
const slotOf = (hour) => (hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 18 ? 1 : hour >= 18 && hour < 23 ? 2 : 3);

const filmTitle = (film) => (typeof film === "string" ? film : film?.title ?? null);

// Un compteur de fréquences qui rend son sommet de façon stable : à égalité, l'ordre alphabétique tranche. Sans
// cela, deux affichages successifs pourraient désigner deux acteurs fétiches différents.
function tally() {
  const entries = new Map();
  return {
    add(label) {
      const key = normalizeText(label);
      if (!key) return;
      const entry = entries.get(key) ?? { label, count: 0 };
      entry.count += 1;
      entries.set(key, entry);
    },
    distinct: () => entries.size,
    // Un sommet à une seule occurrence n'est pas un « fétiche » : c'est la dernière chose qu'on a tapée.
    top(minimum = 2) {
      const ranked = [...entries.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "fr"));
      return ranked[0] && ranked[0].count >= minimum ? ranked[0] : null;
    },
  };
}

function blankStats() {
  return {
    games: 0,
    form: [],
    winStreak: 0,
    recentWins: 0,
    recentGames: 0,
    favouriteActor: null,
    favouriteFilm: null,
    nemesisActor: null,
    favouriteOpening: null,
    distinctActors: 0,
    distinctFilms: 0,
    longestChain: null,
    averageMs: null,
    slot: null,
    mostFrequent: null,
    nemesis: null,
    prey: null,
  };
}

export const EMPTY_ARCHIVE = Object.freeze(blankStats());

export function buildArchiveIndex(history = []) {
  const games = (Array.isArray(history) ? history : [])
    .filter((game) => game?.status === "finished" && Array.isArray(game.players) && game.players.length >= 2);
  // appendHistory empile en tête : games[0] est la plus récente. Tout ce qui suit dépend de cet ordre.

  const index = new Map();

  const seatFor = (key) => {
    let seat = index.get(key);
    if (!seat) {
      seat = {
        ...blankStats(),
        actors: tally(),
        films: tally(),
        refused: tally(),
        openings: tally(),
        partners: new Map(),
        durationSum: 0,
        durationCount: 0,
        hours: [0, 0, 0, 0],
      };
      index.set(key, seat);
    }
    return seat;
  };

  for (const game of games) {
    const winnerId = game.winnerId ?? null;
    const chainLength = game.chain?.length ?? 0;
    const started = game.startedAt ?? null;
    const finished = game.finishedAt ?? null;
    const duration = started && finished && finished > started ? Math.min(finished - started, MAX_SESSION_MS) : null;

    // Les tours sont indexés par joueur une seule fois, pas une fois par joueur.
    const turnsByPlayer = new Map();
    for (const turn of game.turns ?? []) {
      const list = turnsByPlayer.get(turn.playerId) ?? [];
      list.push(turn);
      turnsByPlayer.set(turn.playerId, list);
    }

    for (const player of game.players) {
      const key = normalizeText(player.name);
      if (!key) continue;
      const seat = seatFor(key);
      const won = player.id === winnerId;

      seat.games += 1;
      seat.form.push({ won, chain: chainLength, at: finished ?? started ?? null });
      if (duration !== null) {
        seat.durationSum += duration;
        seat.durationCount += 1;
      }
      if (started) seat.hours[slotOf(new Date(started).getHours())] += 1;
      if (chainLength >= 3 && chainLength > (seat.longestChain?.length ?? 0)) {
        seat.longestChain = { length: chainLength, at: finished ?? started ?? null, won };
      }

      for (const other of game.players) {
        if (other.id === player.id) continue;
        const otherKey = normalizeText(other.name);
        if (!otherKey) continue;
        const pair = seat.partners.get(otherKey) ?? { name: other.name, games: 0, lost: 0, beaten: 0 };
        pair.games += 1;
        if (other.id === winnerId) pair.lost += 1;
        if (won) pair.beaten += 1;
        seat.partners.set(otherKey, pair);
      }

      for (const turn of turnsByPlayer.get(player.id) ?? []) {
        if (!turn.proposedActor || turn.proposedActor === TIMEOUT_ACTOR) continue;
        if (turn.opening) {
          seat.openings.add(turn.proposedActor);
          continue;
        }
        if (turn.accepted) {
          seat.actors.add(turn.proposedActor);
          for (const film of turn.sharedFilms ?? []) seat.films.add(filmTitle(film));
        } else {
          seat.refused.add(turn.proposedActor);
        }
      }
    }
  }

  // Fermeture : les accumulateurs deviennent des valeurs lisibles, une fois.
  for (const seat of index.values()) {
    seat.favouriteActor = seat.actors.top(2);
    seat.favouriteFilm = seat.films.top(2);
    seat.nemesisActor = seat.refused.top(2);
    seat.favouriteOpening = seat.openings.top(2);
    seat.distinctActors = seat.actors.distinct();
    seat.distinctFilms = seat.films.distinct();
    seat.averageMs = seat.durationCount ? Math.round(seat.durationSum / seat.durationCount) : null;

    // La série en cours : les parties les plus récentes gagnées d'affilée. form est en ordre récent d'abord.
    seat.winStreak = 0;
    for (const entry of seat.form) {
      if (!entry.won) break;
      seat.winStreak += 1;
    }

    const recent = seat.form.slice(0, 10);
    seat.recentGames = recent.length;
    seat.recentWins = recent.filter((entry) => entry.won).length;

    // Une séance de prédilection demande au moins trois séances, sinon c'est un hasard nommé.
    const busiest = seat.hours.indexOf(Math.max(...seat.hours));
    seat.slot = seat.hours[busiest] >= 3 ? { label: SLOTS[busiest], count: seat.hours[busiest] } : null;

    // Un adversaire croisé une fois n'est ni fidèle, ni une bête noire.
    const pairs = [...seat.partners.values()].filter((pair) => pair.games >= 2);
    const best = (compare) => [...pairs].sort(compare)[0] ?? null;
    seat.mostFrequent = best((left, right) => right.games - left.games || left.name.localeCompare(right.name, "fr"));
    seat.nemesis = best((left, right) => right.lost - left.lost || left.name.localeCompare(right.name, "fr"));
    seat.prey = best((left, right) => right.beaten - left.beaten || left.name.localeCompare(right.name, "fr"));
    if (seat.nemesis && seat.nemesis.lost < 2) seat.nemesis = null;
    if (seat.prey && seat.prey.beaten < 2) seat.prey = null;
  }

  return index;
}

/* -----------------------------------------------------------------------------
   Les taux, et le socle qui les rend défendables
   -------------------------------------------------------------------------- */

// Un pourcentage n'est pas une division : c'est une promesse de représentativité. En dessous du socle il n'y a pas
// de chiffre à donner — pas un 0 %, pas un 100 %, rien. Le tiret est une réponse.
export const ratio = (part, total, floor) => (total >= floor && total > 0 ? part / total : null);
