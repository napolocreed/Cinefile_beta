import test from "node:test";
import assert from "node:assert/strict";
import { blankProfile, castingRoster, completeProfile, createStorage, recordFinishedGame } from "../src/game/storage.js";

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

const stamped = (name, { games = 0, lastSeenAt = null } = {}) => ({ ...blankProfile(name), games, lastSeenAt });

test("a name added to the casting sheet is stamped with the evening it was seen", () => {
  const storage = createStorage(fakeStorage());
  assert.equal(storage.rememberProfile("Carol", { now: () => 1000 }).lastSeenAt, 1000);
  const again = storage.rememberProfile("CAROL", { now: () => 9000 });
  assert.equal(again.lastSeenAt, 9000);
  assert.equal(again.games, 0);
  assert.equal(again.name, "Carol");
});

test("a finished game stamps profiles from the game itself, and the stamp never goes back", () => {
  const storage = createStorage(fakeStorage());
  recordFinishedGame({ ...finishedGame(), id: "game-late", finishedAt: 5000 }, storage);
  assert.equal(storage.loadProfiles().alice.lastSeenAt, 5000);
  // Restaurer puis rejouer une partie plus ancienne ne doit pas rajeunir la fiche.
  recordFinishedGame({ ...finishedGame(), id: "game-old", finishedAt: 100 }, storage);
  assert.equal(storage.loadProfiles().alice.lastSeenAt, 5000);
  assert.equal(storage.loadProfiles().alice.games, 2);
});

test("a game never renames the profile it belongs to", () => {
  const storage = createStorage(fakeStorage());
  storage.rememberProfile("Alice", { now: () => 1 });
  const game = finishedGame();
  game.players[0].name = "alice";
  recordFinishedGame(game, storage);
  assert.equal(storage.loadProfiles().alice.name, "Alice");
  assert.equal(storage.loadProfiles().alice.games, 1);
});

test("a stamp that a hand-edited backup corrupted is neutralised rather than trusted", () => {
  assert.equal(completeProfile({ name: "Ancien", games: 4 }).lastSeenAt, null);
  assert.equal(completeProfile({ name: "Bricolé", lastSeenAt: "hier" }).lastSeenAt, null);
});

test("the contact sheet ranks by recency, then by games played, then by name", () => {
  const roster = castingRoster({
    zoe: stamped("Zoé", { lastSeenAt: 30 }),
    bob: stamped("Bob", { lastSeenAt: 10, games: 2 }),
    alice: stamped("Alice", { games: 7 }),
    carol: stamped("Carol", { games: 7 }),
    dan: stamped("Dan", { games: 1 }),
  }, [], { visible: 6 });
  assert.deepEqual(roster.shown.map((entry) => entry.key), ["zoe", "bob", "alice", "carol", "dan"]);
  assert.deepEqual(roster.hidden, []);
});

test("the contact sheet cuts at the visible count and hands the rest to the fold", () => {
  const profiles = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`j${String(index).padStart(2, "0")}`, stamped(`Joueur ${index}`, { lastSeenAt: 1000 - index })]));
  const roster = castingRoster(profiles, [], { visible: 6 });
  assert.equal(roster.shown.length, 6);
  assert.equal(roster.hidden.length, 34);
  const shownKeys = new Set(roster.shown.map((entry) => entry.key));
  assert.equal(roster.hidden.some((entry) => shownKeys.has(entry.key)), false);
  assert.deepEqual(roster.shown.map((entry) => entry.key), ["j00", "j01", "j02", "j03", "j04", "j05"]);
});

// L'invariant qui compte pour le pouce : choisir un nom ne doit jamais déplacer les vignettes voisines.
test("a chosen profile deep in the list widens the window instead of jumping to the front", () => {
  const profiles = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`j${String(index).padStart(2, "0")}`, stamped(`Joueur ${index}`, { lastSeenAt: 1000 - index })]));
  const plain = castingRoster(profiles, [], { visible: 6 });
  const withPick = castingRoster(profiles, ["j19"], { visible: 6 });
  assert.equal(withPick.shown.length, 20);
  assert.equal(withPick.shown.at(-1).key, "j19");
  assert.equal(withPick.shown[0].key, plain.shown[0].key);
  assert.deepEqual(withPick.shown.slice(0, 6).map((entry) => entry.key), plain.shown.map((entry) => entry.key));
});

test("corrupted profile entries never reach the contact sheet", () => {
  const roster = castingRoster({ "": stamped("Vide"), alice: null, bob: "texte", carol: stamped("Carol"), dan: ["tableau"] }, [], { visible: 6 });
  assert.deepEqual(roster.shown.map((entry) => entry.key), ["carol"]);
  assert.deepEqual(castingRoster(null).shown, []);
});
