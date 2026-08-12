import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/game/database.js";
import { createGame, nextAliveIndex, proposeActor, replaceLastActor, resolvePending, timeoutPending } from "../src/game/engine.js";

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

test("a true link challenged as a bluff costs the challenger a life and awards two points", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Kate Winslet", database);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio", "Kate Winslet"]);
  assert.equal(game.players[1].score, 2);
  assert.equal(game.players[0].lives, 1);
  assert.equal(game.turns[1].challenged, true);
});

test("an invalid link called as a bluff removes the proposer life and leaves the chain unchanged", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "Louis de Funès", database);
  assert.equal(result.pending.wasValid, false);
  game = resolvePending(result.game, result.pending, { challenged: true });
  assert.deepEqual(game.chain, ["Leonardo DiCaprio"]);
  assert.equal(game.players[1].lives, 1);
  assert.equal(game.players[1].bluffsCaught, 1);
  assert.equal(game.players[0].challengesSuccessful, 1);
  assert.equal(game.players[0].score, 1);
});

test("the no-challenge rule accepts an unknown actor as a vote", () => {
  let game = makeGame({ allowBluffChallenge: false });
  game = proposeActor(game, "Leonardo DiCaprio", database).game;
  const result = proposeActor(game, "An Acteur Inventé", database);
  assert.equal(result.type, "resolved");
  assert.deepEqual(result.game.chain, ["Leonardo DiCaprio", "An Acteur Inventé"]);
  assert.equal(result.game.players[1].bluffsSucceeded, 1);
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
