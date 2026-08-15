import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/game/database.js";
import { adjudicatePending, applyLinkVerification, createGame, nextAliveIndex, proposeActor, replaceLastActor, resolvePending, timeoutPending } from "../src/game/engine.js";

const data = JSON.parse(await readFile(new URL("../src/data/cinema-database.json", import.meta.url)));
const database = createDatabase(data);
const ids = () => {
  let count = 0;
  return () => `player-${++count}`;
};
const makeGame = (config = {}, names = ["Alice", "Bob", "Carol"]) => createGame({ names, config, random: () => 0, now: () => 123, idFactory: ids() });

test("a new game creates players, config and a deterministic starting player", () => {
  const game = makeGame({ livesPerPlayer: 4, turnSeconds: 45 });
  assert.equal(game.players.length, 3);
  assert.equal(game.players[0].lives, 4);
  assert.equal(game.currentPlayerIdx, 0);
  assert.equal(game.status, "in-progress");
  assert.equal(game.chain.length, 0);
});

test("the opening actor starts the chain without awarding a point", () => {
  const game = makeGame();
  const result = proposeActor(game, "Leonardo DiCaprio", database);
  assert.equal(result.type, "resolved");
  assert.deepEqual(result.game.chain, ["Leonardo DiCaprio"]);
  assert.equal(result.game.players[0].score, 0);
  assert.equal(result.game.players[0].filmsFound, 0);
  assert.equal(result.game.currentPlayerIdx, 1);
});

test("a valid link can be accepted and records the shared film", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  assert.equal(result.type, "pending");
  assert.equal(result.pending.sharedFilms.includes("Titanic"), true);
  game = resolvePending(result.game, result.pending, { challenged: false });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Kate Winslet"]);
  assert.equal(game.players[1].score, 1);
  assert.equal(game.players[1].filmsFound, result.pending.sharedFilms.length);
  assert.equal(game.turns[1].accepted, true);
});

// Le défi revient au joueur suivant : Alice ouvre, Bob propose, et c'est Carol — celle qui doit accrocher le
// maillon d'après — qui choisit entre crier au bluff et enchaîner. Ces tests tournent à trois joueurs, le plus
// petit nombre où la règle se distingue de « le joueur précédent » : dès que trois joueurs sont encore en vie
// les deux lectures divergent, mais à deux elles désignent la même personne — ce qui est exactement ce qui a
// laissé l'erreur passer inaperçue.
test("a true link challenged as a bluff costs the challenger a life and awards two points", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  assert.equal(result.pending.challengerId, game.players[2].id);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Kate Winslet"]);
  assert.equal(game.players[1].score, 2);
  assert.equal(game.players[2].lives, 1);
  // Le joueur qui avait déjà joué ne paie rien : il n'avait pas la décision.
  assert.equal(game.players[0].lives, 2);
  assert.equal(game.turns[1].challenged, true);
});

test("an invalid link called as a bluff removes the proposer life and leaves the chain unchanged", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Louis de Funès", database);
  assert.equal(result.pending.wasValid, false);
  assert.equal(result.pending.challengerId, game.players[2].id);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio"]);
  assert.equal(game.players[1].lives, 1);
  assert.equal(game.players[1].bluffsCaught, 1);
  assert.equal(game.players[2].challengesSuccessful, 1);
  assert.equal(game.players[2].score, 1);
  assert.equal(game.players[0].challengesSuccessful, 0);
});

// Un buzz raté ne dispense pas de jouer : le challenger est aussi celui qui doit enchaîner, il perd une vie
// puis prend la main. C'est le cas que l'ancienne lecture rendait impossible à observer.
test("a challenger who buzzed wrongly loses a life and still has to play", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.equal(game.players[2].lives, 1);
  assert.equal(game.currentPlayerIdx, 2);
});

// Et s'il y laisse sa dernière vie, le tour l'enjambe au lieu de rendre la main à un éliminé.
test("a challenger eliminated by their own buzz is skipped when the turn advances", () => {
  let game = makeGame({ livesPerPlayer: 1 }, ["Alice", "Bob", "Carol", "Dan"]);
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.equal(game.players[2].lives, 0);
  assert.equal(game.currentPlayerIdx, 3);
  assert.equal(game.status, "in-progress");
});

test("without bluff challenges an unproven link is held for automatic verification, not waved through", () => {
  let game = makeGame({ allowBluffChallenge: false });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "An Acteur Inventé", database);
  // The move waits for the automatic check instead of resolving on the spot.
  assert.equal(result.type, "pending");
  assert.equal(result.pending.autoVerify, true);
  assert.equal(result.pending.wasValid, false);
  // The chain has NOT grown: an unproven actor is no longer accepted by default.
  assert.deepEqual(result.game.chain, ["Leonardo DiCaprio"]);
});

test("without bluff challenges a catalogue-proven link is accepted automatically", () => {
  let game = makeGame({ allowBluffChallenge: false });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  assert.equal(result.type, "pending");
  assert.equal(result.pending.autoVerify, true);
  assert.equal(result.pending.wasValid, true);
  game = resolvePending(result.game, result.pending, { challenged: false });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Kate Winslet"]);
  assert.equal(game.players[1].score, 1);
  assert.equal(game.turns[1].accepted, true);
  assert.equal(game.turns[1].wasBluff, false);
});

test("without bluff challenges a link ruled invalid breaks the chain and costs a life, not a bluff", () => {
  let game = makeGame({ allowBluffChallenge: false, livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Louis de Funès", database);
  assert.equal(result.pending.autoVerify, true);
  // The table rules it invalid on the VAR screen ("bluff confirmé").
  const ruled = adjudicatePending(result.pending, { valid: false });
  game = resolvePending(result.game, ruled, { challenged: false });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio"]);
  assert.equal(game.players[1].lives, 1);
  // No bluff was attempted in this mode: the loss is a plain invalid link.
  assert.equal(game.players[1].bluffsAttempted, 0);
  assert.equal(game.players[1].bluffsCaught, 0);
  assert.equal(game.turns[1].wasBluff, false);
});

test("without bluff challenges letting a link pass accepts it without a life lost", () => {
  let game = makeGame({ allowBluffChallenge: false, livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Louis de Funès", database);
  // "Laisser passer sans trancher" accepts the move on the benefit of the doubt.
  const passed = adjudicatePending(result.pending, { valid: true, source: "let-pass" });
  game = resolvePending(result.game, passed, { challenged: false });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Louis de Funès"]);
  assert.equal(game.players[1].lives, 2);
  assert.equal(game.turns[1].accepted, true);
});

test("voice keeps its direct accept when bluff challenges are off", () => {
  let game = makeGame({ allowBluffChallenge: false, mode: "voice" }, ["Alice", "Bob"]);
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "An Acteur Inventé", database);
  // The passive voice mode has no VAR screen to fall back on: it resolves as before.
  assert.equal(result.type, "resolved");
  assert.deepEqual(result.game.chain, ["Leonardo DiCaprio", "An Acteur Inventé"]);
});

test("duplicate actors are rejected before changing the game", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  assert.throws(() => proposeActor(game, "Leonardo DiCaprio", database), /déjà été utilisé/);
  assert.equal(game.chain.length, 1);
});

test("timeout creates an invalid pending turn and penalises the current player when resolved", () => {
  let game = proposeActor(makeGame({ livesPerPlayer: 2 }), "Leonardo DiCaprio", database).game;
  const pending = timeoutPending(game);
  assert.equal(pending.method, "timeout");
  // Rien n'a été proposé : personne n'avait à trancher, et le tour ne doit créditer aucune occasion de buzzer.
  assert.equal(pending.challengerId, null);
  game = resolvePending(game, pending);
  assert.equal(game.players[1].lives, 1);
  assert.equal(game.chain.length, 1);
});

test("eliminated players are skipped when the turn advances", () => {
  let game = makeGame({ livesPerPlayer: 1 });
  game.players[1].lives = 0;
  assert.equal(nextAliveIndex(game, 0), 2);
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  assert.equal(game.currentPlayerIdx, 2);
});

test("the game finishes as soon as one survivor remains", () => {
  let game = makeGame({ livesPerPlayer: 1 }, ["Alice", "Bob"]);
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Louis de Funès", database);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.equal(game.status, "finished");
  assert.equal(game.winnerId, game.players[0].id);
});

test("the last accepted actor can be corrected before a voice challenge", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  let result = proposeActor(game, "Kate Winslet", database);
  game = resolvePending(result.game, result.pending, { challenged: false });
  game = replaceLastActor(game, "Tom Hanks", database, { now: () => 456 });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Tom Hanks"]);
  assert.equal(game.turns.at(-1).method, "voice-correction");
  assert.equal(game.turns.at(-1).sharedFilms.includes("Catch Me If You Can"), true);
  assert.equal(game.turns.at(-1).correctedAt, 456);
});

test("a voice correction cannot silently break the previous known link", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  game = resolvePending(result.game, result.pending, { challenged: false });
  const before = structuredClone(game);
  assert.throws(() => replaceLastActor(game, "Louis de Funès", database), /casserait la liaison/);
  assert.deepEqual(game, before);
});

test("a structured fallback confirmation upgrades a pending bluff with evidence", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  const { pending } = proposeActor(game, "An Acteur Inventé", database);
  const verified = applyLinkVerification(pending, {
    verdict: "CONFIRMED",
    source: "wikidata",
    films: [{ title: "Recovered Film", year: 1999 }],
    evidence: [],
  });
  assert.equal(verified.wasValid, true);
  assert.equal(verified.method, "wikidata");
  assert.deepEqual(verified.sharedFilms, ["Recovered Film"]);
  assert.equal(pending.wasValid, false);
});

test("a probable result requires an explicit human VAR decision", () => {
  let game = proposeActor(makeGame(), "Leonardo DiCaprio", database).game;
  const { pending } = proposeActor(game, "An Acteur Inventé", database);
  const probable = applyLinkVerification(pending, { verdict: "PROBABLE", source: "wikipedia", films: [{ title: "Possible Film" }] });
  assert.equal(probable.wasValid, false);
  assert.throws(() => adjudicatePending(probable, {}), /explicite/);
  const accepted = adjudicatePending(probable, { valid: true });
  const rejected = adjudicatePending(probable, { valid: false });
  assert.equal(accepted.wasValid, true);
  assert.deepEqual(accepted.sharedFilms, ["Possible Film"]);
  assert.equal(rejected.wasValid, false);
  assert.deepEqual(rejected.sharedFilms, []);
});

/* -----------------------------------------------------------------------------
   Le périmètre appartient à la partie
   -------------------------------------------------------------------------- */

// La partie du 14 août 2026 : JoeyStarr puis Dany Boon, reliés par « LEGEND » — le plateau de télévision où les
// deux étaient passés, à des années d'écart. Le joueur qui a crié au bluff avait raison, et a perdu une vie.
const showDatabase = () => createDatabase({
  people: [
    { id: "person_joey", name: "JoeyStarr", credits: ["work_show"], source: "snapshot" },
    { id: "person_boon", name: "Dany Boon", credits: ["work_show"], source: "snapshot" },
  ],
  works: [{ id: "work_show", title: "LEGEND", type: "tv", kind: "show", source: "snapshot" }],
});

test("a television show links nobody unless the table opened it", () => {
  const database = showDatabase();
  const strict = proposeActor(proposeActor(makeGame(), "JoeyStarr", database).game, "Dany Boon", database);
  assert.deepEqual(strict.pending.sharedFilms, []);
  assert.equal(strict.pending.wasValid, false);

  const opened = makeGame({ extensions: { shows: true } });
  const linked = proposeActor(proposeActor(opened, "JoeyStarr", database).game, "Dany Boon", database);
  assert.deepEqual(linked.pending.sharedFilms, ["LEGEND"]);
  assert.equal(linked.pending.wasValid, true);
});

test("the scope is written into the game rather than read from the device", () => {
  const game = makeGame({ extensions: { documentaries: true, series: "oui" } });
  assert.deepEqual(game.config.extensions, { documentaries: true, series: false, shows: false });
  // Une sauvegarde antérieure aux extensions se rejoue au socle plutôt que sous des règles indéfinies.
  const legacy = { ...makeGame(), config: { themeId: "classic", livesPerPlayer: 3, allowBluffChallenge: true } };
  legacy.chain = ["JoeyStarr"];
  legacy.turns = [{ index: 0, playerId: legacy.players[0].id, proposedActor: "JoeyStarr", sharedFilms: [], opening: true, accepted: true }];
  assert.deepEqual(proposeActor(legacy, "Dany Boon", showDatabase()).pending.sharedFilms, []);
});

/* -----------------------------------------------------------------------------
   Ce que le tour grave, et ce qu'il ne grave pas
   -------------------------------------------------------------------------- */

// timeoutPending produit un coup wasValid:false sans autoVerify : applyResolution le traitait exactement comme une
// liaison inventée. bluffsAttempted est cumulatif dans le profil et sert de dénominateur permanent à la jauge
// « Bluffs réussis » — chaque temps mort diluait définitivement le taux de bluff du joueur.
test("an expired clock is a lost turn, never an attempted bluff", () => {
  const game = makeGame();
  const opened = proposeActor(game, "Leonardo DiCaprio", database);
  const started = opened.game;
  const after = resolvePending(started, timeoutPending(started), { challenged: false });
  const struck = after.players.find((player) => player.id === started.players[started.currentPlayerIdx].id);
  assert.equal(struck.lives, 2);
  assert.equal(struck.bluffsAttempted, 0);
  assert.equal(after.turns.at(-1).wasBluff, false);
  assert.equal(after.turns.at(-1).method, "timeout");
});

// Le grand livre du générique se déduisait de wasValid, qu'une correction ultérieure du maillon précédent pouvait
// réécrire : la vie perdue disparaissait alors, et avec elle le rang final du joueur.
test("the turn records who paid for it, so a later correction cannot erase the life", () => {
  const game = makeGame({ allowBluffChallenge: true });
  const opened = proposeActor(game, "Leonardo DiCaprio", database);
  const proposed = proposeActor(opened.game, "Kate Winslet", database);
  assert.equal(proposed.type, "pending");
  // La liaison est vraie : le buzz est à tort, et c'est le challenger qui paie.
  const after = resolvePending(proposed.game, proposed.pending, { challenged: true });
  const turn = after.turns.at(-1);
  assert.equal(turn.struckId, proposed.pending.challengerId);
  assert.equal(after.players.find((player) => player.id === turn.struckId).lives, 2);
});

// « Laisser passer sans trancher » enregistrait le tour comme non contesté : le buzz disparaissait du journal et le
// proposant encaissait un bluff jamais démasqué, que le générique commentait par « personne n'a bronché ».
test("letting a proposition pass keeps the buzz on record and punishes nobody", () => {
  const game = makeGame({ allowBluffChallenge: true });
  const opened = proposeActor(game, "Leonardo DiCaprio", database);
  const proposed = proposeActor(opened.game, "Nobody At All", database);
  assert.equal(proposed.type, "pending");
  const letPass = { ...adjudicatePending(proposed.pending, { valid: true, source: "let-pass" }), letPass: true };
  const after = resolvePending(proposed.game, letPass, { challenged: true });

  const turn = after.turns.at(-1);
  assert.equal(turn.challenged, true, "le buzz reste au journal");
  assert.equal(turn.wasBluff, false, "aucun bluff n'est crédité au proposant");
  assert.equal(turn.struckId, null, "personne ne perd de vie");
  const proposer = after.players.find((player) => player.id === turn.playerId);
  const challenger = after.players.find((player) => player.id === turn.challengerId);
  assert.equal(proposer.bluffsSucceeded, 0);
  assert.equal(challenger.challengesMade, 1);
  assert.equal(challenger.lives, 3);
  assert.equal(proposer.lives, 3);
});
