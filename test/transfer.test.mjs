import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/game/diagnostics.js";
import { createStorage } from "../src/game/storage.js";
import { createBackup, parseBackup, restoreBackup, validateBackup } from "../src/game/transfer.js";

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
  const backup = createBackup(source, {
    catalogCache: { version: 1, people: [{ name: "Remote Artist" }] },
    verificationCache: { version: 1, links: [{ left: { name: "Alice" }, right: { name: "Bob" }, films: [{ title: "Film retrouvé" }] }] },
    now: () => 0,
  });
  const parsed = parseBackup(JSON.stringify(backup));

  const targetStorage = memoryStorage();
  const target = createStorage(targetStorage);
  const restored = restoreBackup(parsed, target, { storage: targetStorage });
  assert.equal(restored.profiles, 1);
  assert.equal(restored.games, 1);
  assert.equal(target.loadCurrent().id, "portable-game");
  assert.equal(target.loadSettings().localDiagnostics, true);
  assert.match(targetStorage.getItem("cinefil.catalog-cache.v1"), /Remote Artist/);
  assert.match(targetStorage.getItem("cinefil.verification-cache.v1"), /Film retrouvé/);
  assert.equal(restored.verifiedLinks, 1);
});

test("malformed and oversized imports are rejected before storage changes", () => {
  assert.throws(() => parseBackup("not-json"), /corrompu/);
  assert.throws(() => parseBackup(JSON.stringify({ format: "something-else" })), /pas une sauvegarde/);
  assert.throws(() => parseBackup("0123456789", { maxBytes: 5 }), /volumineuse/);
  const poisoned = createBackup(createStorage(memoryStorage()));
  poisoned.data.verificationCache = {
    version: 1,
    links: [{ left: { name: "Alice" }, right: { name: "Bob" }, films: Array.from({ length: 21 }, () => ({ title: "Film" })) }],
  };
  assert.throws(() => parseBackup(JSON.stringify(poisoned)), /Cache de vérification invalide/);
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

/* -----------------------------------------------------------------------------
   Ce qu'un fichier de sauvegarde n'a pas le droit de casser
   -------------------------------------------------------------------------- */

// La table des profils n'était vérifiée que dans sa forme : n'importe quelle valeur pouvait se trouver derrière une
// clé. Le tri de l'écran Profils lit `.wins` sans garde, et son rendu se fait hors du try/catch de l'import :
// l'écran cessait de se repeindre, et comme c'est lui qui porte le bouton Importer, la sauvegarde saine devenait
// impossible à charger.
test("a profile table with holes in it is refused, not written", () => {
  const sane = createBackup(createStorage(memoryStorage()));
  for (const broken of [{ alice: null }, { bob: "texte" }, { carol: ["x"] }, { "": {} }]) {
    assert.throws(() => validateBackup({ ...sane, data: { ...sane.data, profiles: broken } }), /[Pp]rofil/);
  }
});

// Les fiches étaient écrites brutes : une sauvegarde antérieure à un compteur le laissait absent, et l'écran le
// lisait en undefined.
test("restored profiles arrive complete, whatever the age of the file", () => {
  const storage = createStorage(memoryStorage());
  const sane = createBackup(storage);
  const backup = { ...sane, data: { ...sane.data, profiles: { alice: { name: "Alice", games: 2, wins: 1 } } } };
  restoreBackup(backup, storage, { storage: memoryStorage() });
  const restored = storage.loadProfiles().alice;
  assert.equal(restored.games, 2);
  assert.equal(restored.turnsPlayed, 0);
  assert.equal(restored.livesLost, 0);
  assert.equal(Array.isArray(restored.opponents), true);
});

// L'import écrasait profils et historique avant de buter sur le quota du cache, et laissait l'exception remonter :
// l'utilisateur croyait l'import annulé alors que sa base était déjà détruite.
test("an import that cannot fit puts the previous save back", () => {
  const values = new Map();
  let refuse = false;
  const storage = createStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (refuse && key.includes("catalog-cache")) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  });
  storage.saveProfiles({ alice: { name: "Alice", games: 12 } });

  const sane = createBackup(createStorage(memoryStorage()));
  const incoming = {
    ...sane,
    data: { ...sane.data, profiles: { bob: { name: "Bob", games: 1 } }, catalogCache: { version: 1, people: [] } },
  };
  refuse = true;
  const cacheStore = {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {},
  };
  assert.throws(() => restoreBackup(incoming, storage, { storage: cacheStore }), /insuffisant/);
  // La base d'origine est intacte : rien n'a été perdu au passage.
  assert.equal(storage.loadProfiles().alice?.games, 12);
  assert.equal(storage.loadProfiles().bob, undefined);
});

// L'export soumettait ses propres données au validateur d'import : une seule entrée abîmée dans le stockage —
// exactement le cas où l'export sert de filet — faisait échouer le téléchargement entier, sans fichier ni message.
test("a corrupted entry is dropped from the export instead of cancelling it", () => {
  const storage = createStorage(memoryStorage());
  storage.replaceHistory([
    { id: "sain", status: "finished", players: [{ id: "p1", name: "Alice", lives: 1 }, { id: "p2", name: "Bob", lives: 0 }], chain: ["X"], turns: [] },
    { id: "abime", status: "finished", players: [] },
  ]);
  storage.saveProfiles({ alice: { name: "Alice" }, "": { name: "Sans clé" } });

  const backup = createBackup(storage, { catalogCache: { version: 9, people: "non" } });
  assert.deepEqual(backup.data.history.map((game) => game.id), ["sain"]);
  assert.deepEqual(Object.keys(backup.data.profiles), ["alice"]);
  assert.equal(backup.data.catalogCache, null);
  // Et ce qui sort reste importable.
  assert.doesNotThrow(() => validateBackup(backup));
});
