import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/game/database.js";
import { createHybridCatalog, createVerificationSearchLinks, normalizeApiBase } from "../src/game/catalog.js";

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

test("only a usable http origin is borrowed, anything else falls back to the same origin", () => {
  assert.equal(normalizeApiBase("https://cinefil.example/"), "https://cinefil.example");
  assert.equal(normalizeApiBase("https://cinefil.example/api-proxy/"), "https://cinefil.example/api-proxy");
  assert.equal(normalizeApiBase("  https://cinefil.example:8443  "), "https://cinefil.example:8443");
  for (const rejected of ["", "   ", "javascript:alert(1)", "ftp://cinefil.example", "cinefil.example", "https://cinefil.example/?token=x", "https://cinefil.example/#/api"]) {
    assert.equal(normalizeApiBase(rejected), "", rejected);
  }
});

test("the catalogue names the deployment it is talking to", async () => {
  const seed = { actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] };
  const withOptions = (options) => createHybridCatalog({ database: createDatabase(seed), storage: memoryStorage(), fetchImpl: async () => jsonResponse({ configured: false, source: "local" }), ...options });
  assert.equal(withOptions({}).getState().mode, "server");
  assert.equal(withOptions({}).getState().origin, null);
  assert.equal(withOptions({ remoteEnabled: false }).getState().mode, "local");
  assert.equal(withOptions({ apiBase: "https://cinefil.example" }).getState().mode, "borrowed");
  // A meta tag filled with nonsense must not promise a live catalogue the page cannot reach.
  assert.equal(withOptions({ apiBase: "pas-une-url" }).getState().mode, "server");
});

test("a borrowed API origin carries every catalogue call, and only to that origin", async () => {
  const database = createDatabase({ actors: [{ name: "Alice Local", films: ["Film A"], tags: [] }], films: ["Film A"] });
  const requests = [];
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    apiBase: "https://cinefil.example/",
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/api/catalog/status")) return jsonResponse({ configured: true, source: "tmdb" });
      if (String(url).includes("/api/catalog/search")) return jsonResponse({ configured: true, source: "tmdb", results: [{ id: "tmdb:505710", name: "Zendaya", roles: ["acting"], externalIds: { tmdb: 505710 }, origin: "tmdb" }] });
      return jsonResponse({ verdict: "NOT_FOUND", source: "none", films: [], evidence: [] });
    },
  });
  const status = await catalog.status();
  assert.equal(status.mode, "borrowed");
  assert.equal(status.origin, "https://cinefil.example");
  assert.equal(status.configured, true);
  const search = await catalog.search("Zendaya");
  assert.deepEqual(search.results.map((person) => person.name), ["Zendaya"]);
  assert.equal((await catalog.verifyLink("Alice Local", "Zendaya")).verdict, "NOT_FOUND");
  assert.deepEqual(requests.map((url) => new URL(url).origin), ["https://cinefil.example", "https://cinefil.example", "https://cinefil.example"]);
  assert.deepEqual(requests.map((url) => new URL(url).pathname), ["/api/catalog/status", "/api/catalog/search", "/api/verify-link"]);
});

test("an unreachable borrowed origin falls back to the shipped snapshot", async () => {
  const database = createDatabase({
    people: [{ id: "person_alice", name: "Alice Local", credits: ["work:a"], source: "snapshot" }],
    works: [{ id: "work:a", title: "Film A", type: "movie", source: "snapshot" }],
  });
  let shippedLookups = 0;
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    apiBase: "https://cinefil.example",
    staticHydrate: async (candidate) => {
      shippedLookups += 1;
      return database.findActor(candidate.id) ?? database.findActor(candidate.name) ?? null;
    },
    fetchImpl: async () => { throw new Error("network"); },
  });
  const status = await catalog.status();
  assert.equal(status.online, false);
  assert.equal(status.mode, "borrowed");
  assert.deepEqual((await catalog.search("Alice")).results.map((person) => person.name), ["Alice Local"]);
  assert.equal((await catalog.hydrate(database.findActor("Alice Local"))).name, "Alice Local");
  assert.equal(shippedLookups, 1);
  const verification = await catalog.verifyLink("Alice Local", "Bob Inconnu");
  assert.equal(verification.verdict, "UNKNOWN");
  assert.deepEqual(verification.steps.map((step) => step.outcome), ["empty", "error", "error", "error"]);
});

test("the borrowed origin is asked only for the artists the shipped overlay lacks", async () => {
  const database = createDatabase({
    people: [{ id: "person_alice", name: "Alice Local", credits: ["work:a"], source: "snapshot" }],
    works: [{ id: "work:a", title: "Film A", type: "movie", source: "snapshot" }],
  });
  const requests = [];
  const catalog = createHybridCatalog({
    database,
    storage: memoryStorage(),
    apiBase: "https://cinefil.example",
    staticHydrate: async (candidate) => database.findActor(candidate.id) ?? database.findActor(candidate.name) ?? null,
    fetchImpl: async (url) => {
      requests.push(String(url));
      return jsonResponse({ configured: true, source: "tmdb", person: { id: "tmdb:505710", name: "Zendaya", aliases: [], roles: ["acting"], tags: [], externalIds: { tmdb: 505710 }, credits: [{ id: "tmdb-movie:8", title: "Dune", year: 2021, type: "movie", externalIds: { tmdbMovie: 8 }, source: "tmdb" }], source: "tmdb" } });
    },
  });
  assert.equal((await catalog.hydrate(database.findActor("Alice Local"))).films.includes("Film A"), true);
  assert.deepEqual(requests, []);
  const remote = await catalog.hydrate({ name: "Zendaya", externalIds: { tmdb: 505710 }, origin: "tmdb" });
  assert.deepEqual(remote.films, ["Dune"]);
  assert.deepEqual(requests, ["https://cinefil.example/api/catalog/people/tmdb/505710"]);
});

test("a filmography the server could not send never costs the artist", async () => {
  const database = createDatabase({ actors: [], films: [] });
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), apiBase: "https://cinefil.example", fetchImpl: async () => { throw new Error("network"); } });
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
