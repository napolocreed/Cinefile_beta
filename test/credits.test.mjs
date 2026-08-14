// The credits are read back out of the turn log alone, so what they claim about a game has to be checked against
// a game the engine actually played — above all the bluff that was never called, which no other screen ever shows.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/game/database.js";
import { buildCredits, creditsSignature } from "../src/game/credits.js";
import { createGame, proposeActor, resolvePending, timeoutPending } from "../src/game/engine.js";

const data = JSON.parse(await readFile(new URL("../src/data/cinema-database.json", import.meta.url)));
const database = createDatabase(data);

const ids = () => {
  let count = 0;
  return () => `player-${++count}`;
};
const makeGame = (config = {}, names = ["Alice", "Bob"]) => createGame({ names, config, random: () => 0, now: () => 1000, idFactory: ids() });

const play = (game, actor, { challenged = false } = {}) => {
  const result = proposeActor(game, actor, database);
  if (result.type === "resolved") return result.game;
  return resolvePending(result.game, result.pending, { challenged });
};

// Alice opens, Bob links for real, Alice bluffs and nobody says a word, Bob bluffs and is caught.
function playedGame() {
  let game = makeGame({ livesPerPlayer: 2 });
  game = play(game, "Leonardo DiCaprio");
  game = play(game, "Kate Winslet");
  game = play(game, "Louis de Funès");
  game = play(game, "Meryl Streep", { challenged: true });
  return game;
}

test("the reel follows the chain and names the film that holds each pair together", () => {
  const credits = buildCredits(playedGame(), { database });
  assert.deepEqual(credits.reel.map((entry) => entry.actor), ["Leonardo DiCaprio", "Kate Winslet", "Louis de Funès"]);
  assert.equal(credits.reel[0].from, null);
  assert.equal(credits.reel[1].from, "Leonardo DiCaprio");
  assert.equal(credits.reel[1].films.includes("Titanic"), true);
  assert.equal(credits.opening, "Leonardo DiCaprio");
  assert.equal(credits.closing, "Louis de Funès");
});

test("a bluff nobody called is credited as such, with no film to show for it", () => {
  const credits = buildCredits(playedGame(), { database });
  const slipped = credits.bluffs.slipped;
  assert.equal(slipped.length, 1);
  assert.equal(slipped[0].actor, "Louis de Funès");
  assert.equal(slipped[0].from, "Kate Winslet");
  assert.equal(slipped[0].playerName, "Alice");
  assert.deepEqual(slipped[0].films, []);
  const entry = credits.reel.find((candidate) => candidate.actor === "Louis de Funès");
  assert.equal(entry.bluff, true);
  assert.equal(entry.redeemed, false);
  assert.equal(credits.tally.bluffsSlipped, 1);
});

test("a bluff that was called is credited to whoever called it, and costs its author a life", () => {
  const credits = buildCredits(playedGame(), { database });
  assert.equal(credits.bluffs.unmasked.length, 1);
  const scene = credits.bluffs.unmasked[0];
  assert.equal(scene.actor, "Meryl Streep");
  assert.equal(scene.playerName, "Bob");
  assert.equal(scene.challengerName, "Alice");
  assert.equal(scene.struckName, "Bob");
  assert.equal(scene.livesLeft, 1);
  assert.equal(scene.eliminated, false);
  // Refused, so it never joined the chain — but it was named, and the roll still says so.
  assert.deepEqual(credits.guests.map((guest) => guest.name), ["Meryl Streep"]);
  assert.equal(credits.guests[0].kind, "bluff-unmasked");
});

test("a buzz on a true link is a false alarm, and the challenger pays for it", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = play(game, "Leonardo DiCaprio");
  game = play(game, "Kate Winslet", { challenged: true });
  const credits = buildCredits(game, { database });
  assert.equal(credits.bluffs.falseAlarms.length, 1);
  const scene = credits.bluffs.falseAlarms[0];
  assert.equal(scene.challengerName, "Alice");
  assert.equal(scene.struckName, "Alice");
  assert.equal(scene.livesLeft, 1);
  assert.equal(credits.tally.challengesWrong, 1);
  assert.equal(credits.tally.challengesRight, 0);
  assert.equal(credits.cast.find((member) => member.name === "Alice").challengesLost, 1);
});

test("the life ledger is rebuilt turn by turn, up to the elimination that ends the game", () => {
  let game = makeGame({ livesPerPlayer: 1 });
  game = play(game, "Leonardo DiCaprio");
  game = play(game, "Bourvil", { challenged: true });
  assert.equal(game.status, "finished");
  const credits = buildCredits(game, { database });
  const last = credits.scenes.at(-1);
  assert.equal(last.eliminated, true);
  assert.equal(last.livesLeft, 0);
  assert.equal(credits.winnerName, "Alice");
  assert.equal(credits.cast.find((member) => member.name === "Bob").eliminatedAt, 2);
  assert.equal(credits.tally.livesLost, 1);
});

test("a turn eaten by the chrono is a scene of its own and never reaches the cast list", () => {
  let game = makeGame({ livesPerPlayer: 2 });
  game = play(game, "Leonardo DiCaprio");
  game = resolvePending(game, timeoutPending(game), { challenged: false });
  const credits = buildCredits(game, { database });
  const scene = credits.scenes.at(-1);
  assert.equal(scene.kind, "timeout");
  assert.equal(scene.struckName, "Bob");
  assert.deepEqual(credits.guests, []);
  assert.equal(credits.tally.timeouts, 1);
  assert.equal(credits.cast.find((member) => member.name === "Bob").timeouts, 1);
});

test("the cast is billed in seat order and every player leaves with a title", () => {
  const credits = buildCredits(playedGame(), { database });
  assert.deepEqual(credits.cast.map((member) => member.name), ["Alice", "Bob"]);
  assert.equal(credits.cast.every((member) => typeof member.role === "string" && member.role.length > 0), true);
  // One bluff through, so the title goes to its author rather than to the scoreboard leader.
  assert.equal(credits.cast.find((member) => member.name === "Alice").role, "illusionist");
  assert.equal(credits.cast.find((member) => member.name === "Alice").bluffsSlipped, 1);
  assert.equal(credits.cast.find((member) => member.name === "Bob").bluffsUnmasked, 1);
});

test("a link the engine could not prove is looked up again, and credited when the archive answers", () => {
  const game = playedGame();
  // A turn taken on a vote keeps no proof; the credits ask the catalogue rather than declaring the link empty.
  const linked = game.turns.find((turn) => turn.proposedActor === "Kate Winslet");
  linked.sharedFilms = [];
  linked.wasValid = false;
  linked.wasBluff = true;
  const credits = buildCredits(game, { database });
  const entry = credits.reel.find((candidate) => candidate.actor === "Kate Winslet");
  assert.equal(entry.lateEvidence, true);
  assert.equal(entry.redeemed, true);
  assert.equal(entry.films.includes("Titanic"), true);
  // Without a catalogue there is nothing to find, and the roll says the pair had nothing in common.
  const blind = buildCredits(game);
  assert.deepEqual(blind.reel.find((candidate) => candidate.actor === "Kate Winslet").films, []);
});

test("the signature moves with the log, so a cached roll is never one turn behind", () => {
  const game = playedGame();
  const before = creditsSignature(game);
  assert.equal(buildCredits(game, { database }).signature, before);
  const next = play(game, "Bourvil");
  assert.notEqual(creditsSignature(next), before);
  // The end stamp lands after the last turn, so a roll cached a moment earlier has to be rebuilt for it.
  assert.notEqual(creditsSignature({ ...game, finishedAt: 42 }), before);
  assert.equal(creditsSignature(null), "none");
});

test("an unplayed game still produces an empty but complete reel", () => {
  const credits = buildCredits(makeGame(), { database });
  assert.deepEqual(credits.reel, []);
  assert.deepEqual(credits.scenes, []);
  assert.equal(credits.cast.length, 2);
  assert.equal(credits.opening, null);
  assert.equal(credits.tally.acts, 0);
  assert.equal(buildCredits(null), null);
});
