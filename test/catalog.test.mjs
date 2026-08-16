import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/game/database.js";
import { CATALOG_CACHE_KEY, createHybridCatalog, createVerificationSearchLinks, VERIFICATION_CACHE_KEY } from "../src/game/catalog.js";

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

// Deux artistes TMDb distincts portent parfois le même nom. Tant que le rapprochement retombait sur le nom dès que
// les identifiants différaient, le second homonyme se recollait sur la fiche déjà enrichie et lui laissait SON
// identifiant : l'acteur héritait du numéro de l'animateur et devenait inatteignable.
test("two remote namesakes stay two distinct people", async () => {
  const database = createDatabase({ actors: [{ name: "Chris Evans", films: ["Film Local"], tags: [] }], films: ["Film Local"] });
  const fetchImpl = async () => jsonResponse({ configured: true, source: "tmdb", results: [
    { id: "tmdb:16828", name: "Chris Evans", knownFor: ["Le Bouclier"], roles: ["acting"], externalIds: { tmdb: 16828 }, origin: "tmdb" },
    { id: "tmdb:1215774", name: "Chris Evans", knownFor: ["Le Plateau"], roles: ["acting"], externalIds: { tmdb: 1215774 }, origin: "tmdb" },
  ] });
  const catalog = createHybridCatalog({ database, fetchImpl, storage: memoryStorage() });
  const { results } = await catalog.search("Chris", { limit: 8 });
  assert.equal(results.length, 2);
  // La fiche locale est enrichie par le premier homonyme, et le second ne peut plus s'y recoller.
  assert.equal(String(results[0].externalIds.tmdb), "16828");
  assert.deepEqual(results[0].knownFor, ["Le Bouclier"]);
  assert.equal(String(results[1].externalIds.tmdb), "1215774");
});

// Le filtre des artistes déjà joués ne s'appliquait qu'au catalogue local : TMDb réinjectait le maillon qu'on venait
// d'en retirer, et la suggestion menait droit à « Cet acteur a déjà été utilisé », chrono en cours.
test("an artist already in the chain is not re-proposed by the remote catalogue", async () => {
  const database = createDatabase({ actors: [{ name: "Kate Winslet", films: ["Titanic"], tags: [] }], films: ["Titanic"] });
  const fetchImpl = async () => jsonResponse({ configured: true, source: "tmdb", results: [
    { id: "tmdb:204", name: "Kate Winslet", roles: ["acting"], externalIds: { tmdb: 204 }, origin: "tmdb" },
  ] });
  const catalog = createHybridCatalog({ database, fetchImpl, storage: memoryStorage() });
  const { results } = await catalog.search("Kate", { limit: 8, excluded: ["Leonardo DiCaprio", "Kate Winslet"] });
  assert.deepEqual(results, []);
});

test("hydrating a TMDb result adds credits and persists an offline cache", async () => {
  const storage = memoryStorage();
  const database = createDatabase({ actors: [], films: [] });
  const person = { id: "tmdb:42", name: "Alice Remote", aliases: [], roles: ["acting"], tags: [], externalIds: { tmdb: 42 }, credits: [{ id: "tmdb-movie:7", title: "Film B", year: 2024, type: "movie", externalIds: { tmdbMovie: 7 }, source: "tmdb" }], source: "tmdb" };
  const catalog = createHybridCatalog({ database, storage, fetchImpl: async () => jsonResponse({ person }) });
  const hydrated = await catalog.hydrate({ name: person.name, externalIds: person.externalIds, origin: "tmdb" });
  assert.deepEqual(hydrated.films, ["Film B"]);
  assert.match(storage.getItem(CATALOG_CACHE_KEY), /Alice Remote/);

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
  assert.match(storage.getItem(VERIFICATION_CACHE_KEY), /Film retrouvé/);

  const reloadedDatabase = createDatabase(seed);
  // Une session plus tard, sans réseau : la preuve apprise tient toute seule.
  const offlineCatalog = createHybridCatalog({ database: reloadedDatabase, storage, fetchImpl: async () => { throw new Error("network"); } });
  assert.deepEqual(reloadedDatabase.sharedFilms("Alice", "Bob"), ["Film retrouvé"]);
  assert.equal((await offlineCatalog.verifyLink("Alice", "Bob")).source, "local");
  assert.equal(offlineCatalog.getVerificationCache().links.length, 1);
});

// La fiche existante porte `films`, une liste de TITRES bruts. La renvoyer à upsertPerson les faisait re-résoudre
// par le titre, et un homonyme indexé sous la même clé récupérait la place : une preuve confirmée sur une paire
// raccrochait l'artiste à des œuvres qu'il n'a jamais tournées, pour toutes les autres paires.
test("a confirmed proof never rewrites the rest of an artist's filmography", async () => {
  const seed = {
    works: [
      { id: "work_film", title: "Beau Geste", type: "movie", kind: "cinema", source: "snapshot" },
      { id: "work_show", title: "Beau geste", type: "tv", kind: "series", source: "snapshot" },
    ],
    people: [
      { id: "person_alice", name: "Alice Un", credits: ["work_show"], source: "snapshot" },
      { id: "person_bob", name: "Bob Deux", credits: [], source: "snapshot" },
      { id: "person_carl", name: "Carl Trois", credits: ["work_film"], source: "snapshot" },
    ],
  };
  const database = createDatabase(seed);
  // Au départ Alice tient l'émission, Carl le film : ils n'ont rien en commun au socle.
  assert.deepEqual(database.sharedFilms("Alice Un", "Carl Trois"), []);

  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => jsonResponse({
    verdict: "CONFIRMED",
    source: "wikidata",
    films: [{ title: "Preuve Commune", year: 2001, qid: "Q1" }],
    evidence: [],
  }) });
  assert.equal((await catalog.verifyLink("Alice Un", "Bob Deux")).verdict, "CONFIRMED");

  // La preuve entre bien, et rien d'autre ne bouge : Alice n'a pas hérité du film homonyme de Carl.
  assert.deepEqual(database.sharedFilms("Alice Un", "Bob Deux"), ["Preuve Commune"]);
  assert.deepEqual(database.sharedFilms("Alice Un", "Carl Trois"), []);
  assert.equal(database.findActor("Alice Un").films.includes("Beau geste"), true);
  assert.equal(database.findActor("Alice Un").films.includes("Beau Geste"), false);
});

/* -----------------------------------------------------------------------------
   Le périmètre, du côté du joueur
   -------------------------------------------------------------------------- */

test("a confirmed proof enters the catalogue with its nature, not as a film by default", async () => {
  const storage = memoryStorage();
  const seed = { actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] };
  const database = createDatabase(seed);
  const catalog = createHybridCatalog({ database, storage, fetchImpl: async () => jsonResponse({
    verdict: "CONFIRMED",
    source: "tmdb",
    films: [{ title: "Un plateau", year: 2023, kind: "show", type: "tv" }],
    evidence: [],
  }) });
  const opened = await catalog.verifyLink("Alice", "Bob", { extensions: { shows: true } });
  assert.equal(opened.verdict, "CONFIRMED");
  // La preuve est apprise telle qu'elle est : une émission, et non « un film » comme l'écrivait la version
  // précédente. C'est ce qui permet à la partie suivante de la refuser sans avoir à réinterroger qui que ce soit.
  assert.equal(catalog.getVerificationCache().links[0].films[0].kind, "show");
  assert.deepEqual(database.sharedFilms("Alice", "Bob"), []);
  assert.deepEqual(database.sharedFilms("Alice", "Bob", "classic", { extensions: { shows: true } }), ["Un plateau"]);
});

test("an out-of-scope answer is an absence of proof, never a proof of absence", async () => {
  const database = createDatabase({ actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] });
  // Une réponse mise en cache une journée par le serveur peut arriver après que la table a refermé son périmètre.
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async () => jsonResponse({
    verdict: "CONFIRMED",
    source: "wikidata",
    films: [{ title: "Un documentaire", kind: "documentary" }],
    evidence: [{ title: "Un documentaire", kind: "documentary" }],
  }) });
  const result = await catalog.verifyLink("Alice", "Bob");
  assert.equal(result.verdict, "NOT_FOUND");
  assert.deepEqual(result.films, []);
  assert.equal(result.source, "none");
  assert.equal(catalog.getVerificationCache().links.length, 0);
});

test("the scope travels with the question", async () => {
  const requests = [];
  const database = createDatabase({ actors: [{ name: "Alice", films: [] }, { name: "Bob", films: [] }], films: [] });
  const catalog = createHybridCatalog({ database, storage: memoryStorage(), fetchImpl: async (url) => {
    requests.push(String(url));
    return jsonResponse({ verdict: "NOT_FOUND", source: "none", films: [], evidence: [] });
  } });
  await catalog.verifyLink("Alice", "Bob", { extensions: { documentaries: true } });
  const scope = new URL(requests[0], "https://cinefil.test").searchParams.get("scope");
  assert.deepEqual(scope.split(","), ["cinema", "documentary", "unknown"]);
});
