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
// maillon d'après — qui choisit entre crier au bluff et enchaîner. Ces deux tests tournent à trois joueurs,
// seul nombre où la règle se distingue de « le joueur précédent » : à deux, les deux désignent la même
// personne, ce qui est exactement ce qui a laissé l'erreur passer inaperçue.
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
