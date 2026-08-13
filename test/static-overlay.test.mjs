import test from "node:test";
import assert from "node:assert/strict";
import { createHybridCatalog } from "../src/game/catalog.js";
import { createDatabase } from "../src/game/database.js";
import { createStaticOverlay } from "../src/game/static-overlay.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("the static catalogue loads only the selected TMDb filmography shard", async () => {
  const database = createDatabase({
    works: [{ id: "work:base", title: "Film A", year: 2000, type: "movie", source: "snapshot" }],
    people: [{ id: "person:alice", name: "Alice Local", credits: ["work:base"], source: "snapshot" }],
  });
  const syncedAt = new Date().toISOString();
  const index = {
    version: 1,
    people: [{
      id: "tmdb:42",
      localPersonId: "person:alice",
      name: "Alice Example-Smith",
      aliases: ["Alice L."],
      roles: ["acting"],
      externalIds: { tmdb: 42 },
      syncedAt,
      shard: "person_alice.json",
    }],
  };
  const shard = {
    version: 1,
    person: { ...index.people[0], credits: ["tmdb-movie:7"], source: "tmdb" },
    works: [{ id: "tmdb-movie:7", title: "Film B", year: 2024, type: "movie", externalIds: { tmdbMovie: 7 }, source: "tmdb" }],
  };
  const requests = [];
  const staticOverlay = createStaticOverlay({
    database,
    index,
    resolveAsset: (path) => `/Cinefile_beta/${path}`,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return { ok: true, status: 200, json: async () => shard };
    },
  });
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    remoteEnabled: false,
    staticHydrate: staticOverlay.hydrate,
  });

  const result = await catalog.search("Alice");
  assert.equal(requests.length, 0);
  assert.equal(result.results[0].externalIds.tmdb, 42);
  const hydrated = await catalog.hydrate(result.results[0]);
  assert.equal(hydrated.name, "Alice Local");
  assert.equal(hydrated.aliases.includes("Alice Example-Smith"), true);
  assert.deepEqual(hydrated.films.sort(), ["Film A", "Film B"]);
  assert.deepEqual(requests, ["/Cinefile_beta/src/data/tmdb-shards/person_alice.json"]);
  await catalog.hydrate(result.results[0]);
  assert.equal(requests.length, 1);
  assert.deepEqual(staticOverlay.stats(), { indexed: 1, loaded: 1 });
});
