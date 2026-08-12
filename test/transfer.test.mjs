import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/game/diagnostics.js";
import { createStorage } from "../src/game/storage.js";
import { createBackup, parseBackup, restoreBackup } from "../src/game/transfer.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const game = {
  version: 3,
  id: "portable-game",
  status: "in-progress",
  winnerId: null,
  players: [{ id: "a", name: "Alice", lives: 3 }, { id: "b", name: "Bob", lives: 2 }],
  chain: ["Kate Winslet"],
  turns: [],
};

test("a validated backup round-trips game, profiles, history, settings and catalogue", () => {
  const sourceStorage = memoryStorage();
  const source = createStorage(sourceStorage);
  source.saveCurrent(game);
  source.replaceHistory([{ ...game, id: "old-game", status: "finished" }]);
  source.saveProfiles({ alice: { name: "Alice", games: 2 } });
  source.replaceApplied(["old-game"]);
  source.saveSettings({ localDiagnostics: true });
  const backup = createBackup(source, { catalogCache: { version: 1, people: [{ name: "Remote Artist" }] }, now: () => 0 });
  const parsed = parseBackup(JSON.stringify(backup));

  const targetStorage = memoryStorage();
  const target = createStorage(targetStorage);
  const restored = restoreBackup(parsed, target, { storage: targetStorage });
  assert.equal(restored.profiles, 1);
  assert.equal(restored.games, 1);
  assert.equal(target.loadCurrent().id, "portable-game");
  assert.equal(target.loadSettings().localDiagnostics, true);
  assert.match(targetStorage.getItem("cinefil.catalog-cache.v1"), /Remote Artist/);
});

test("malformed and oversized imports are rejected before storage changes", () => {
  assert.throws(() => parseBackup("not-json"), /corrompu/);
  assert.throws(() => parseBackup(JSON.stringify({ format: "something-else" })), /pas une sauvegarde/);
  assert.throws(() => parseBackup("0123456789", { maxBytes: 5 }), /volumineuse/);
});

test("diagnostics stay local, opt-in and capped", () => {
  const local = memoryStorage();
  const diagnostics = createDiagnostics(local, { pathname: "/play" });
  assert.equal(diagnostics.capture(new Error("ignored")), false);
  diagnostics.setEnabled(true);
  for (let index = 0; index < 40; index += 1) diagnostics.capture(new Error(`failure-${index}`), { phase: "test" });
  assert.equal(diagnostics.load().length, 30);
  assert.equal(diagnostics.load()[0].message, "failure-39");
  assert.equal(diagnostics.load()[0].path, "/play");
  diagnostics.setEnabled(false);
  assert.deepEqual(diagnostics.load(), []);
});
