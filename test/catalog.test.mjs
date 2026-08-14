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

// Le serveur injoignable est le cas ordinaire d'un jeu de salon : réseau capricieux, tunnel, avion. Le snapshot
// embarqué doit alors tout porter, sans que rien ne se casse ni ne mente.
test("an unreachable server falls back to the shipped snapshot", async () => {
  const database = createDatabase({
    people: [{ id: "person_alice", name: "Alice Local", credits: ["work:a"], source: "snapshot" }],
    works: [{ id: "work:a", title: "Film A", type: "movie", source: "snapshot" }],
  });
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    fetchImpl: async () => { throw new Error("network"); },
  });
  const status = await catalog.status();
  assert.equal(status.online, false);
  assert.deepEqual((await catalog.search("Alice")).results.map((person) => person.name), ["Alice Local"]);
  assert.equal((await catalog.hydrate(database.findActor("Alice Local"))).name, "Alice Local");
  const verification = await catalog.verifyLink("Alice Local", "Bob Inconnu");
  assert.equal(verification.verdict, "UNKNOWN");
  assert.deepEqual(verification.steps.map((step) => step.outcome), ["empty", "error", "error", "error"]);
});

test("a device that knows it is offline says so and calls nobody", async () => {
  const database = createDatabase({ actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] });
  let calls = 0;
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => { calls += 1; return jsonResponse({ configured: true, source: "tmdb", results: [] }); } });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  try {
    const result = await catalog.search("Alice");
    assert.deepEqual(result.results.map((person) => person.name), ["Alice Local"]);
    assert.equal(result.remote.online, false);
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
});

// Deux routes, deux besoins : la fiche du snapshot se fait enrichir sous son identité locale — le nom affiché
// reste celui de la table — et TMDb n'est appelé que pour ce que le snapshot n'a jamais eu.
test("a snapshot artist is enriched under its local identity, TMDb only serves what is missing", async () => {
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
      if (String(url).includes("/people/local/")) {
        return jsonResponse({ person: { id: "tmdb:99", name: "Alice Remote", aliases: [], roles: ["acting"], tags: [], externalIds: { tmdb: 99 }, credits: [{ id: "tmdb-movie:1", title: "Film A", year: 1999, type: "movie", externalIds: { tmdbMovie: 1 }, source: "tmdb" }], source: "tmdb" } });
      }
      return jsonResponse({ person: { id: "tmdb:505710", name: "Zendaya", aliases: [], roles: ["acting"], tags: [], externalIds: { tmdb: 505710 }, credits: [{ id: "tmdb-movie:8", title: "Dune", year: 2021, type: "movie", externalIds: { tmdbMovie: 8 }, source: "tmdb" }], source: "tmdb" } });
    },
  });

  const local = await catalog.hydrate(database.findActor("Alice Local"));
  assert.equal(local.name, "Alice Local");
  assert.equal(local.films.includes("Film A"), true);
  assert.deepEqual(requests, ["/api/catalog/people/local/person_alice"]);

  const remote = await catalog.hydrate({ name: "Zendaya", externalIds: { tmdb: 505710 }, origin: "tmdb" });
  assert.deepEqual(remote.films, ["Dune"]);
  assert.deepEqual(requests, ["/api/catalog/people/local/person_alice", "/api/catalog/people/tmdb/505710"]);

  // Une deuxième demande sur la même identité se sert du cache local plutôt que du réseau.
  await catalog.hydrate({ name: "Zendaya", externalIds: { tmdb: 505710 }, origin: "tmdb" });
  assert.equal(requests.length, 2);
});

test("a filmography the server could not send never costs the artist", async () => {
  const database = createDatabase({ actors: [], films: [] });
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => { throw new Error("network"); } });
  const person = await catalog.hydrate({ name: "Zendaya", externalIds: { tmdb: 505710 }, origin: "tmdb" });
  assert.equal(person.name, "Zendaya");
  assert.equal(catalog.getState().online, false);
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

// Hors ligne, la cascade n'est pas « vide » : elle n'a pas été posée. Les recherches manuelles restent offertes,
// et le verdict reste UNKNOWN plutôt que de laisser croire que le film n'existe pas.
test("offline link verification calls nobody and still offers the human searches", async () => {
  const database = createDatabase({ actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] });
  let fetchCalls = 0;
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => { fetchCalls += 1; } });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  try {
    const result = await catalog.verifyLink("Alice", "Bob");
    assert.equal(result.verdict, "UNKNOWN");
    assert.equal(result.offline, true);
    assert.equal(fetchCalls, 0);
  } finally {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  }
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
  // Une session plus tard, sans réseau : la preuve apprise tient toute seule.
  const offlineCatalog = createHybridCatalog({ database: reloadedDatabase, storage, fetchImpl: async () => { throw new Error("network"); } });
  assert.deepEqual(reloadedDatabase.sharedFilms("Alice", "Bob"), ["Film retrouvé"]);
  assert.equal((await offlineCatalog.verifyLink("Alice", "Bob")).source, "local");
  assert.equal(offlineCatalog.getVerificationCache().links.length, 1);
});
