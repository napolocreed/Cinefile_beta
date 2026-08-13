import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/game/database.js";
import { createHybridCatalog, createVerificationSearchLinks } from "../src/game/catalog.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("hybrid search combines local matches with remote artists and disambiguation data", async () => {
  const database = createDatabase({ actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] });
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/api\/catalog\/search/);
    return jsonResponse({ configured: true, source: "tmdb", results: [{ id: "tmdb:42", name: "Alice Remote", knownFor: ["Film B"], roles: ["acting"], externalIds: { tmdb: 42 }, origin: "tmdb" }] });
  };
  const catalog = createHybridCatalog({ database, fetchImpl, storage: memoryStorage() });
  const result = await catalog.search("Alice", { limit: 8 });
  assert.deepEqual(result.results.map((person) => person.name), ["Alice Local", "Alice Remote"]);
  assert.deepEqual(result.results[1].knownFor, ["Film B"]);
  assert.equal(result.remote.configured, true);
});

test("hydrating a TMDb result adds credits and persists an offline cache", async () => {
  const storage = memoryStorage();
  const database = createDatabase({ actors: [], films: [] });
  const person = { id: "tmdb:42", name: "Alice Remote", aliases: [], roles: ["acting"], tags: [], externalIds: { tmdb: 42 }, credits: [{ id: "tmdb-movie:7", title: "Film B", year: 2024, type: "movie", externalIds: { tmdbMovie: 7 }, source: "tmdb" }], source: "tmdb" };
  const catalog = createHybridCatalog({ database, storage, fetchImpl: async () => jsonResponse({ person }) });
  const hydrated = await catalog.hydrate({ name: person.name, externalIds: person.externalIds, origin: "tmdb" });
  assert.deepEqual(hydrated.films, ["Film B"]);
  assert.match(storage.getItem("cinefil.catalog-cache.v1"), /Alice Remote/);

  const offlineDatabase = createDatabase({ actors: [], films: [] });
  createHybridCatalog({ database: offlineDatabase, storage, fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual(offlineDatabase.findActor("Alice Remote")?.films, ["Film B"]);
});

test("hybrid search keeps local results when the remote catalogue is down", async () => {
  const database = createDatabase({ actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] });
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => { throw new Error("network"); } });
  const result = await catalog.search("Alice");
  assert.deepEqual(result.results.map((person) => person.name), ["Alice Local"]);
  assert.equal(result.remote.online, false);
});

test("a local artist is hydrated from the published server catalogue on demand", async () => {
  const database = createDatabase({
    people: [{ id: "person_alice", name: "Alice Local", credits: ["work:a"], source: "snapshot" }],
    works: [{ id: "work:a", title: "Film A", type: "movie", source: "snapshot" }],
  });
  const requests = [];
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return jsonResponse({
        source: "published-tmdb",
        person: {
          id: "tmdb:42",
          localPersonId: "person_alice",
          name: "Alice Remote",
          aliases: [],
          externalIds: { tmdb: 42 },
          credits: [{ id: "tmdb-movie:7", title: "Film B", type: "movie", externalIds: { tmdbMovie: 7 }, source: "tmdb" }],
          source: "tmdb",
        },
      });
    },
  });
  const hydrated = await catalog.hydrate(database.findActor("Alice Local"));
  assert.equal(hydrated.name, "Alice Local");
  assert.equal(hydrated.aliases.includes("Alice Remote"), true);
  assert.deepEqual(hydrated.films.sort(), ["Film A", "Film B"]);
  assert.deepEqual(requests, ["/api/catalog/people/local/person_alice"]);
});

test("static catalogue mode never calls a server API", async () => {
  const database = createDatabase({ actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] });
  let fetchCalls = 0;
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    remoteEnabled: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Static mode must not fetch");
    },
  });
  const status = await catalog.status();
  const result = await catalog.search("Alice");
  assert.equal(status.static, true);
  assert.equal(status.source, "snapshot");
  assert.deepEqual(result.results.map((person) => person.name), ["Alice Local"]);
  assert.equal(fetchCalls, 0);
});

test("link verification prefers local evidence and never calls the remote cascade", async () => {
  const database = createDatabase({ actors: [{ name: "Alice", films: ["Film A"] }, { name: "Bob", films: ["Film A"] }], films: ["Film A"] });
  let fetchCalls = 0;
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => { fetchCalls += 1; } });
  const result = await catalog.verifyLink("Alice", "Bob");
  assert.equal(result.verdict, "CONFIRMED");
  assert.equal(result.source, "local");
  assert.deepEqual(result.films.map((film) => film.title), ["Film A"]);
  assert.equal(fetchCalls, 0);
});

test("remote link verification sends stable IDs and preserves human search links", async () => {
  const database = createDatabase({
    people: [
      { id: "person_a", name: "Alice", externalIds: { tmdb: 10 }, credits: [] },
      { id: "person_b", name: "Bob", externalIds: { tmdb: 20 }, credits: [] },
    ],
    works: [],
  });
  let requestedUrl;
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async (url) => {
    requestedUrl = String(url);
    return jsonResponse({ verdict: "NOT_FOUND", source: "none", films: [], evidence: [] });
  } });
  const result = await catalog.verifyLink("Alice", "Bob");
  assert.equal(result.verdict, "NOT_FOUND");
  assert.equal(new URL(requestedUrl, "https://cinefil.test").searchParams.get("leftTmdbId"), "10");
  assert.equal(new URL(requestedUrl, "https://cinefil.test").searchParams.get("rightTmdbId"), "20");
  assert.match(result.searchLinks.google, /Alice/);
});

test("static link verification stays offline and produces deterministic VAR links", async () => {
  const database = createDatabase({ actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] });
  let fetchCalls = 0;
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), remoteEnabled: false, fetchImpl: async () => { fetchCalls += 1; } });
  const result = await catalog.verifyLink("Alice", "Bob");
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.offline, true);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(Object.keys(createVerificationSearchLinks("Alice", "Bob")), ["google", "duckduckgo", "qwant", "wikipedia"]);
});

test("positive fallback evidence teaches the local catalogue across sessions", async () => {
  const storage = memoryStorage();
  const seed = { actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] };
  const database = createDatabase(seed);
  const catalog = createHybridCatalog({ database, storage, fetchImpl: async () => jsonResponse({
    verdict: "CONFIRMED",
    source: "wikidata",
    films: [{ title: "Film retrouvé", year: 1999, qid: "Q999" }],
    evidence: [],
  }) });
  const result = await catalog.verifyLink("Alice", "Bob");
  assert.equal(result.verdict, "CONFIRMED");
  assert.deepEqual(database.sharedFilms("Alice", "Bob"), ["Film retrouvé"]);
  assert.match(storage.getItem("cinefil.verification-cache.v1"), /Film retrouvé/);

  const reloadedDatabase = createDatabase(seed);
  const offlineCatalog = createHybridCatalog({ database: reloadedDatabase, storage, remoteEnabled: false });
  assert.deepEqual(reloadedDatabase.sharedFilms("Alice", "Bob"), ["Film retrouvé"]);
  assert.equal((await offlineCatalog.verifyLink("Alice", "Bob")).source, "local");
  assert.equal(offlineCatalog.getVerificationCache().links.length, 1);
});
