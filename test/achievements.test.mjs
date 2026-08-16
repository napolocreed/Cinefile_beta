// Un succès qui se décroche par accident de données ne récompense rien. Ce qui se vérifie ici, c'est d'abord ce
// que le tableau d'honneur REFUSE : une partie de deux tours, un profil vierge, un compteur absent d'une vieille
// sauvegarde. Ensuite seulement, que les conditions se déclenchent quand elles doivent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ACHIEVEMENTS, FAMILIES, TIERS, achievementById, achievementsFor, partieValable, progressFor } from "../src/game/achievements.js";
import { buildCredits } from "../src/game/credits.js";
import { createDatabase } from "../src/game/database.js";
import { createGame, proposeActor, resolvePending, timeoutPending } from "../src/game/engine.js";
import { blankProfile, createStorage, recordFinishedGame } from "../src/game/storage.js";

const data = JSON.parse(await readFile(new URL("../src/data/cinema-database.json", import.meta.url)));
const database = createDatabase(data);

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

// Un compteur global : deux parties de suite doivent porter deux identifiants distincts, sinon la seconde est
// ignorée par la garde d'idempotence de recordFinishedGame et le test observe une partie qui n'a rien enregistré.
let identifier = 0;
const ids = () => () => `p-${++identifier}`;

// Une chaîne dont chaque maillon est vérifié contre le snapshot réel : sans ça, un « bluff » involontaire
// fausserait tous les compteurs que ces tests observent.
const CHAIN = [
  "Leonardo DiCaprio", "Gérard Depardieu", "Michel Piccoli", "Harold Lloyd", "Anthony Quinn", "John Wayne",
  "Mickey Rooney", "Buster Keaton", "Vittorio De Sica", "Michel Galabru", "Bernard Blier", "Jean Carmet",
  "Louis de Funès", "Fernandel",
];
// Une réserve de maillons valides pour relancer la chaîne entre deux coups fatals.
const SPARE = ["Jean-Claude Brialy", "Charles Vanel", "Michel Serrault", "Isabelle Huppert"];
// Des noms qu'aucun catalogue ne connaît : la liaison est intenable quelle que soit la fin de la chaîne, et un
// nom distinct par coup, parce qu'une proposition acceptée ne peut pas être resservie.
const killer = (round) => `Artiste Introuvable ${round}`;

// Une chaîne longue et honnête — de quoi que partieValable reconnaisse la partie et que le vainqueur ait signé
// ses six liaisons — puis des coups fatals jusqu'à ce qu'un joueur y laisse toutes ses vies. Entre deux, la
// chaîne repart sur un maillon valide, si bien que c'est toujours le même joueur qui trinque.
function playedGame({ players = ["Alice", "Bob"], lives = 1, config = {}, actors = CHAIN, kill = "challenge" } = {}) {
  let game = createGame({ names: players, config: { livesPerPlayer: lives, ...config }, random: () => 0, now: () => 1000, idFactory: ids() });
  const play = (actor, challenged) => {
    const result = proposeActor(game, actor, database);
    game = result.type === "resolved" ? result.game : resolvePending(result.game, result.pending, { challenged });
  };
  for (const actor of actors) {
    play(actor, false);
    if (game.status === "finished") return game;
  }
  if (!kill) return game;
  for (const [round, spare] of [null, ...SPARE].entries()) {
    if (spare) play(spare, false);
    if (game.status === "finished") return game;
    // Le chrono coûte une vie quel que soit le mode, sans passer par la vérification de liaison : c'est le coup
    // fatal le plus simple à provoquer ici.
    if (kill === "timeout") game = resolvePending(game, timeoutPending(game), { challenged: false });
    else play(killer(round), true);
    if (game.status === "finished") return game;
  }
  return game;
}

test("the catalogue is coherent: unique ids, real families and tiers, one emoji each", () => {
  assert.equal(ACHIEVEMENTS.length >= 45, true);
  assert.equal(new Set(ACHIEVEMENTS.map((achievement) => achievement.id)).size, ACHIEVEMENTS.length);
  for (const achievement of ACHIEVEMENTS) {
    assert.equal(Object.hasOwn(FAMILIES, achievement.family), true, achievement.id);
    assert.equal(Object.hasOwn(TIERS, achievement.tier), true, achievement.id);
    assert.equal(typeof achievement.earn, "function", achievement.id);
    assert.equal(achievement.label.length <= 28, true, achievement.id);
    assert.equal(achievement.description.endsWith("."), true, achievement.id);
  }
  assert.equal(achievementById("carriere-premiere-seance")?.tier, "bronze");
  assert.equal(achievementById("inconnu"), null);
});

// Le garde-fou principal : rien ne se décroche sur une partie qui n'a pas eu lieu.
test("a game too short to mean anything awards nothing at all", () => {
  const game = playedGame({ actors: CHAIN.slice(0, 2) });
  const credits = buildCredits(game);
  assert.equal(partieValable(game, credits), false);
  const profile = { ...blankProfile("Alice"), games: 40, wins: 30, filmsFound: 900 };
  const earned = achievementsFor(game, profile, { player: game.players[0], credits });
  // Seuls les succès qui ne dépendent pas de la partie peuvent tomber, et le catalogue n'en a aucun de gratuit.
  assert.deepEqual(earned.filter((id) => id.startsWith("carriere-")), []);
});

test("an empty profile earns nothing, and a missing counter never throws", () => {
  const game = playedGame();
  const credits = buildCredits(game);
  assert.deepEqual(achievementsFor(game, blankProfile("Neuf"), { player: game.players[0], credits }).filter((id) => id.startsWith("carriere-")), []);
  // Une fiche d'avant la migration n'a aucun des nouveaux compteurs : elle ne doit pas faire tomber le calcul.
  const legacy = { name: "Ancien", games: 3, wins: 1, achievements: [] };
  assert.doesNotThrow(() => achievementsFor(game, legacy, { player: game.players[0], credits }));
  assert.equal(achievementsFor(null, blankProfile("X")).length, 0);
});

// L'écran des scores se revisite — il porte lui-même « Revoir le générique », qui y ramène. Le second passage
// rappelait recordFinishedGame, tombait sur la garde d'idempotence et écrasait les cartons avec un tableau vide :
// le classement restait, le bloc « Nouveaux succès » disparaissait.
test("the cards earned by a game are still owed on a second visit", () => {
  const storage = createStorage(fakeStorage());
  const game = playedGame();
  const first = recordFinishedGame(game, storage);
  assert.equal(first.newAchievements.length > 0, true);
  const second = recordFinishedGame(game, storage);
  assert.deepEqual(second.newAchievements, first.newAchievements);
  // Et rien n'a été recompté au passage.
  assert.equal(storage.loadHistory().length, 1);
});

// recordFinishedGame reconstruisait le rouleau sans la base, alors que l'écran du générique le bâtit avec. Une même
// partie produisait donc deux rouleaux, et c'est le plus pauvre — sans les films retrouvés aux archives — qui
// alimentait les compteurs de profil et les succès. Le rouleau est désormais celui qu'on lui remet.
test("the roll handed in is the one the game is judged on", () => {
  const storage = createStorage(fakeStorage());
  const game = playedGame();
  const roll = buildCredits(game, { database });
  assert.equal(roll.tally.acts >= 6, true);

  // Jugée sur un rouleau écourté, la partie n'est plus « valable » : la série de soirée ne démarre pas.
  const shortened = recordFinishedGame(game, storage, { credits: { ...roll, tally: { ...roll.tally, acts: 2 } } });
  const winnerKey = game.players.find((player) => player.id === game.winnerId).name.toLowerCase();
  assert.equal(shortened.profiles[winnerKey].streakRun, 0);

  // Jugée sur le vrai rouleau, elle la démarre.
  const other = createStorage(fakeStorage());
  const full = recordFinishedGame(game, other, { credits: roll });
  assert.equal(full.profiles[winnerKey].streakRun, 1);
});

test("a first finished game opens the career, and only the career", () => {
  const storage = createStorage(fakeStorage());
  const game = playedGame();
  assert.equal(game.status, "finished");
  const { profiles, newAchievements } = recordFinishedGame(game, storage);
  const winner = game.players.find((player) => player.id === game.winnerId);
  const key = winner.name.toLowerCase();
  assert.equal(profiles[key].achievements.includes("carriere-premiere-seance"), true);
  assert.equal(profiles[key].achievements.includes("carriere-premiere-victoire"), true);
  // Le perdant a joué sa première partie, sans la gagner.
  const loser = game.players.find((player) => player.id !== game.winnerId);
  assert.equal(profiles[loser.name.toLowerCase()].achievements.includes("carriere-premiere-seance"), true);
  assert.equal(profiles[loser.name.toLowerCase()].achievements.includes("carriere-premiere-victoire"), false);
  // Et la table entière reçoit ses cartons, pas seulement le vainqueur.
  assert.equal(new Set(newAchievements.map((entry) => entry.playerName)).size, 2);
});

test("the ledger records what the game did, once, and never twice", () => {
  const storage = createStorage(fakeStorage());
  const game = playedGame();
  recordFinishedGame(game, storage);
  const first = storage.loadProfiles();
  const key = Object.keys(first)[0];
  assert.equal(first[key].games, 1);
  assert.equal(first[key].turnsPlayed > 0, true);
  assert.equal(first[key].links > 0, true);
  assert.equal(first[key].rankSum > 0, true);
  assert.equal(first[key].tableSeats, 2);
  assert.equal(first[key].gamesToday, 1);
  assert.equal(first[key].opponents.length, 1);
  assert.equal(first[key].firstPlayedAt, game.startedAt);
  recordFinishedGame(game, storage);
  assert.equal(storage.loadProfiles()[key].games, 1);
});

test("a win streak, a comeback, and the day counter follow the results", () => {
  const storage = createStorage(fakeStorage());
  const winnerName = () => {
    const game = playedGame();
    recordFinishedGame(game, storage);
    return game.players.find((player) => player.id === game.winnerId).name;
  };
  const champion = winnerName();
  const key = champion.toLowerCase();
  assert.equal(storage.loadProfiles()[key].streakRun, 1);
  winnerName();
  assert.equal(storage.loadProfiles()[key].streakRun, 2);
  assert.equal(storage.loadProfiles()[key].bestWinStreak, 2);
  assert.equal(storage.loadProfiles()[key].gamesToday, 2);
  // Le vaincu accumule des défaites, en négatif, sur le même entier.
  const other = Object.keys(storage.loadProfiles()).find((candidate) => candidate !== key);
  assert.equal(storage.loadProfiles()[other].streakRun, -2);
});

// Le test ci-dessous ne portait que le cas négatif, sur une partie qui n'avait de toute façon aucun bluff passé :
// il restait vert même si la garde disparaissait. Voici la moitié qui manquait — un bluff réellement passé sous les
// yeux d'une table autorisée à buzzer, qui lui, doit compter.
test("a bluff nobody challenged is counted when the table could have", () => {
  const storage = createStorage(fakeStorage());
  // Le dernier maillon est un nom qu'aucun catalogue ne relie au précédent, et personne ne conteste.
  let game = playedGame({ config: { allowBluffChallenge: true }, lives: 3, kill: null });
  const slipped = proposeActor(game, "Nom Totalement Inconnu", database);
  assert.equal(slipped.type, "pending");
  assert.equal(slipped.pending.wasValid, false);
  game = resolvePending(slipped.game, slipped.pending, { challenged: false });
  // Il faut que la partie se termine pour être enregistrée.
  while (game.status !== "finished") game = resolvePending(game, timeoutPending(game), { challenged: false });

  const { profiles } = recordFinishedGame(game, storage);
  const bluffer = Object.values(profiles).find((profile) => profile.bluffsSlipped > 0);
  assert.ok(bluffer, "un bluff passé doit être porté par une fiche");
  assert.equal(bluffer.bluffsSlipped >= 1, true);
  assert.equal(bluffer.achievements.includes("bluff-premier-trucage"), true);
});

test("the honour roll only counts a bluff that slipped past a table allowed to buzz", () => {
  const storage = createStorage(fakeStorage());
  // Sans défis de bluff, le moteur accepte d'office toute liaison invalide : ce n'est pas un bluff réussi.
  const game = playedGame({ config: { allowBluffChallenge: false }, kill: "timeout" });
  recordFinishedGame(game, storage);
  for (const profile of Object.values(storage.loadProfiles())) {
    assert.equal(profile.bluffsSlipped, 0);
    assert.equal(profile.achievements.includes("bluff-premier-trucage"), false);
  }
});

test("progress is only offered for what a profile alone can measure", () => {
  const profile = { ...blankProfile("Alice"), filmsFound: 30, games: 12, wins: 4, flawlessWins: 2 };
  assert.deepEqual(progressFor(achievementById("carriere-films-50"), profile), { value: 30, target: 50 });
  assert.deepEqual(progressFor(achievementById("exploit-cinq-sans-rayure"), profile), { value: 2, target: 5 });
  // Une progression ne dépasse jamais sa cible, et un succès de partie n'en a pas.
  assert.deepEqual(progressFor(achievementById("carriere-films-50"), { ...profile, filmsFound: 999 }), { value: 50, target: 50 });
  assert.equal(progressFor(achievementById("exploit-pellicule-intacte"), profile), null);
  assert.equal(progressFor(null, profile), null);
  const measurable = ACHIEVEMENTS.filter((achievement) => achievement.progress);
  assert.equal(measurable.length >= 10, true);
  for (const achievement of measurable) {
    const empty = progressFor(achievement, blankProfile("Neuf"));
    assert.equal(empty === null || empty.value === 0, true, achievement.id);
  }
});

test("a flawless win is recorded, and five of them unlock the medal", () => {
  const storage = createStorage(fakeStorage());
  const profiles = {};
  // On force la fiche à quatre victoires sans rayure : la cinquième doit décrocher le succès.
  // Deux vies chacun : gagner sans en perdre une seule veut alors dire quelque chose.
  const game = playedGame({ lives: 2 });
  const winner = game.players.find((player) => player.id === game.winnerId);
  profiles[winner.name.toLowerCase()] = { ...blankProfile(winner.name), flawlessWins: 4 };
  storage.saveProfiles(profiles);
  recordFinishedGame(game, storage);
  const profile = storage.loadProfiles()[winner.name.toLowerCase()];
  assert.equal(profile.flawlessWins, 5);
  assert.equal(profile.achievements.includes("exploit-cinq-sans-rayure"), true);
});
