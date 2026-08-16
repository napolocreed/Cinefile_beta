// buildArchiveIndex n'avait aucun test : c'est pourtant lui qui construit toute la fiche d'un joueur — acteur
// fétiche, bête noire, forme récente, créneau de prédilection — à partir des cinquante dernières parties. Cent
// vingt lignes ne s'exécutaient jamais sous le harnais.

import test from "node:test";
import assert from "node:assert/strict";
import { buildArchiveIndex, EMPTY_ARCHIVE, ratio, SLOTS } from "../src/game/statistics.js";

// Une partie terminée, écrite comme le moteur l'écrit. Les tours portent leur nature : c'est d'eux que la fiche
// tire les acteurs joués, les films retenus et les liaisons refusées.
function game({ id, winner = "Alice", players = ["Alice", "Bob"], chain = [], turns = [], startedAt = 0, finishedAt = 0 }) {
  const seats = players.map((name, index) => ({ id: `p${index + 1}`, name, lives: name === winner ? 3 : 0 }));
  return {
    id,
    status: "finished",
    winnerId: seats.find((seat) => seat.name === winner)?.id ?? null,
    players: seats,
    chain,
    turns: turns.map((turn, index) => ({
      index,
      playerId: seats.find((seat) => seat.name === turn.by)?.id ?? null,
      proposedActor: turn.actor,
      accepted: turn.accepted !== false,
      opening: Boolean(turn.opening),
      sharedFilms: turn.films ?? [],
      wasValid: turn.accepted !== false,
    })),
    startedAt,
    finishedAt,
  };
}

// L'historique empile en tête : la première entrée est la partie la plus récente.
const history = [
  game({
    id: "g3", winner: "Alice", chain: ["Jean Gabin", "Michel Simon"], startedAt: 3_000, finishedAt: 3_600_000,
    turns: [
      { by: "Alice", actor: "Jean Gabin", opening: true },
      { by: "Bob", actor: "Michel Simon", films: ["Quai des brumes"] },
      { by: "Alice", actor: "Nom Refusé", accepted: false },
    ],
  }),
  game({
    id: "g2", winner: "Bob", chain: ["Jean Gabin", "Arletty"], startedAt: 2_000, finishedAt: 1_800_000,
    turns: [
      { by: "Alice", actor: "Jean Gabin", opening: true },
      { by: "Bob", actor: "Arletty", films: ["Quai des brumes"] },
    ],
  }),
  game({
    id: "g1", winner: "Alice", chain: ["Louis Jouvet"], startedAt: 1_000, finishedAt: 900_000,
    turns: [{ by: "Alice", actor: "Louis Jouvet", opening: true }],
  }),
];

test("an empty archive answers without inventing anything", () => {
  const index = buildArchiveIndex([]);
  assert.equal(index.size, 0);
  assert.equal(EMPTY_ARCHIVE.games, 0);
  assert.equal(EMPTY_ARCHIVE.favouriteActor, null);
});

test("only finished games with a real table enter the archive", () => {
  const index = buildArchiveIndex([
    { id: "encours", status: "in-progress", players: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }], turns: [], chain: [] },
    { id: "solo", status: "finished", players: [{ id: "p1", name: "Alice" }], turns: [], chain: [] },
    ...history,
  ]);
  assert.equal(index.get("alice").games, 3);
  assert.equal(index.get("bob").games, 3);
});

test("the archive reads recent-first, which is what the form strip depends on", () => {
  const alice = buildArchiveIndex(history).get("alice");
  // g3 gagnée, g2 perdue, g1 gagnée : la série en cours vaut 1, et la bande commence par la plus récente.
  assert.equal(alice.winStreak, 1);
  assert.equal(alice.form[0].won, true);
  assert.equal(alice.form[1].won, false);
  assert.equal(alice.recentGames, 3);
  assert.equal(alice.recentWins, 2);
});

// Un sommet à une seule occurrence est la dernière chose qu'on a tapée, pas un fétiche.
test("a favourite needs two occurrences, a one-off stays null", () => {
  const once = buildArchiveIndex([history[2]]).get("alice");
  assert.equal(once.favouriteActor, null);
  assert.equal(once.favouriteOpening, null);

  const twice = buildArchiveIndex(history).get("alice");
  // Alice ouvre sur « Jean Gabin » dans g3 et g2 : deux fois, donc une ouverture de prédilection.
  assert.equal(twice.favouriteOpening?.label, "Jean Gabin");
  // « Quai des brumes » est retenu deux fois par Bob, jamais par Alice.
  assert.equal(buildArchiveIndex(history).get("bob").favouriteFilm?.label, "Quai des brumes");
});

test("a refused link feeds the nemesis, an accepted one never does", () => {
  const alice = buildArchiveIndex(history).get("alice");
  // Une seule liaison refusée : sous le seuil, la bête noire reste muette plutôt que de désigner un hasard.
  assert.equal(alice.nemesisActor, null);
  const stubborn = buildArchiveIndex([
    game({ id: "gx", winner: "Bob", chain: [], turns: [{ by: "Alice", actor: "Nom Refusé", accepted: false }] }),
    ...history,
  ]).get("alice");
  assert.equal(stubborn.nemesisActor?.label, "Nom Refusé");
});

test("the stage direction the engine writes for a timeout is never counted as an artist", () => {
  const index = buildArchiveIndex([
    game({ id: "gt", winner: "Bob", chain: [], turns: [
      { by: "Alice", actor: "(temps écoulé)", accepted: false },
      { by: "Alice", actor: "(temps écoulé)", accepted: false },
    ] }),
  ]);
  const alice = index.get("alice");
  assert.equal(alice.nemesisActor, null);
  assert.equal(alice.favouriteActor, null);
  assert.equal(alice.distinctActors, 0);
});

test("the average session and the favourite slot are read from real clocks", () => {
  const alice = buildArchiveIndex(history).get("alice");
  assert.equal(Number.isFinite(alice.averageMs), true);
  assert.equal(alice.averageMs > 0, true);
  // Le créneau est un compteur, pas une chaîne : il porte son libellé et le nombre de séances.
  assert.equal(SLOTS.includes(alice.slot.label), true);
  assert.equal(alice.slot.count, 3);
});

test("an opponent becomes a nemesis or a prey only past the threshold", () => {
  const alice = buildArchiveIndex(history).get("alice");
  // Trois parties contre Bob, deux gagnées : c'est lui le plus fréquent, et Alice le domine.
  assert.equal(alice.mostFrequent?.name, "Bob");
  assert.equal(alice.mostFrequent?.games, 3);
  assert.equal(alice.prey?.name, "Bob");
  assert.equal(alice.prey?.beaten, 2);
  // Personne ne domine Alice : la bête noire reste muette plutôt que de désigner l'unique adversaire.
  assert.equal(alice.nemesis, null);
  // Et la lecture est symétrique : Bob, lui, a Alice pour bête noire.
  const bob = buildArchiveIndex(history).get("bob");
  assert.equal(bob.nemesis?.name, "Alice");
  assert.equal(bob.prey, null);
});

test("a ratio without its floor stays null rather than lying", () => {
  assert.equal(ratio(1, 2, 5), null);
  assert.equal(ratio(3, 10, 5), 0.3);
  assert.equal(ratio(0, 0, 1), null);
});
