import test from "node:test";
import assert from "node:assert/strict";
import { blankProfile, completeProfile, createStorage, recordFinishedGame } from "../src/game/storage.js";

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

test("a name can become a profile before it has ever played", () => {
  const storage = createStorage(fakeStorage());
  const created = storage.rememberProfile("  Carol  ");
  assert.equal(created.name, "Carol");
  assert.equal(created.games, 0);
  assert.deepEqual(created.achievements, []);
  assert.deepEqual(Object.keys(storage.loadProfiles()), ["carol"]);
  // A profile with no history still counts its first game like any other.
  const played = recordFinishedGame({ ...finishedGame(), players: [
    { id: "p1", name: "Carol", filmsFound: 3, bluffsSucceeded: 0, bluffsCaught: 0, score: 3, bestStreak: 1 },
    { id: "p2", name: "Bob", filmsFound: 0, bluffsSucceeded: 0, bluffsCaught: 0, score: 0, bestStreak: 0 },
  ] }, storage);
  assert.equal(played.profiles.carol.games, 1);
  assert.equal(played.profiles.carol.filmsFound, 3);
});

test("remembering a name twice never overwrites the profile already there", () => {
  const storage = createStorage(fakeStorage());
  recordFinishedGame(finishedGame(), storage);
  const again = storage.rememberProfile("ALICE");
  assert.equal(again.games, 1);
  // The spelling on file wins: a casting call must not rename a history.
  assert.equal(again.name, "Alice");
  assert.equal(storage.rememberProfile("   "), null);
});

test("a profile can be dropped from the archives", () => {
  const storage = createStorage(fakeStorage());
  storage.rememberProfile("Dimitri");
  assert.equal(storage.forgetProfile("dimitri"), true);
  assert.deepEqual(storage.loadProfiles(), {});
  assert.equal(storage.forgetProfile("dimitri"), false);
});

test("a profile saved before a counter existed is completed rather than trusted", () => {
  const legacy = completeProfile({ name: "Ancien", games: 4, wins: 2 });
  assert.deepEqual(legacy, { ...blankProfile("Ancien"), games: 4, wins: 2 });
  assert.equal(completeProfile(undefined, "Neuf").games, 0);
});
