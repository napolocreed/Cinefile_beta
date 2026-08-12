import test from "node:test";
import assert from "node:assert/strict";
import { createStorage, recordFinishedGame } from "../src/game/storage.js";

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function finishedGame() {
  return {
    id: "game-1",
    status: "finished",
    winnerId: "p1",
    chain: ["Leonardo DiCaprio", "Kate Winslet"],
    turns: [{ playerId: "p1", wasValid: true }],
    players: [
      { id: "p1", name: "Alice", filmsFound: 2, bluffsSucceeded: 1, bluffsCaught: 0, score: 2, bestStreak: 2 },
      { id: "p2", name: "Bob", filmsFound: 0, bluffsSucceeded: 0, bluffsCaught: 0, score: 0, bestStreak: 0 },
    ],
  };
}

test("finished games update profiles and history", () => {
  const storage = createStorage(fakeStorage());
  const result = recordFinishedGame(finishedGame(), storage);
  assert.equal(result.profiles.alice.games, 1);
  assert.equal(result.profiles.alice.wins, 1);
  assert.equal(result.profiles.alice.filmsFound, 2);
  assert.equal(storage.loadHistory().length, 1);
  assert.equal(storage.loadApplied().length, 1);
});

test("finished games are idempotent across a refresh", () => {
  const storage = createStorage(fakeStorage());
  const game = finishedGame();
  recordFinishedGame(game, storage);
  const second = recordFinishedGame(game, storage);
  assert.deepEqual(second.newAchievements, []);
  assert.equal(storage.loadProfiles().alice.games, 1);
  assert.equal(storage.loadHistory().length, 1);
});
