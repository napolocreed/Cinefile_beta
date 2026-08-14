import test from "node:test";
import assert from "node:assert/strict";
import { createLinkVerifier, createVerificationSearchLinks } from "../src/server/verify.js";

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

function wikidataCandidates(name) {
  const id = name === "Jean Dujardin" ? "Q189422" : "Q182021";
  return { search: [{ id, label: name, description: "actor" }] };
}

test("Wikidata confirms a shared film after TMDb is unavailable", async () => {
  const requests = [];
  const verifier = createLinkVerifier({
    tmdb: { configured: false },
    fetchImpl: async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.includes("wbsearchentities")) return jsonResponse(wikidataCandidates(new URL(value).searchParams.get("search")));
      if (value.includes("qlever.dev")) return jsonResponse({ results: { bindings: [{
        film: { value: "http://www.wikidata.org/entity/Q20001199" },
        filmLabel: { value: "The Artist" },
        year: { value: "2020" },
        left: { value: "http://www.wikidata.org/entity/Q189422" },
        right: { value: "http://www.wikidata.org/entity/Q182021" },
      }, {
        film: { value: "http://www.wikidata.org/entity/Q20001199" },
        filmLabel: { value: "The Artist" },
        year: { value: "2011" },
        left: { value: "http://www.wikidata.org/entity/Q189422" },
        right: { value: "http://www.wikidata.org/entity/Q182021" },
      }] } });
      if (value.includes("wikipedia.org/w/api.php")) return jsonResponse({ query: { search: [] } });
      throw new Error(`Unexpected URL ${value}`);
    },
  });
  const result = await verifier.verify({ left: "Jean Dujardin", right: "Bérénice Bejo" });
  assert.equal(result.verdict, "CONFIRMED");
  assert.equal(result.source, "wikidata");
  assert.deepEqual(result.films.map((film) => film.title), ["The Artist"]);
  assert.equal(result.films[0].year, 2011);
  const sparql = new URL(requests.find((request) => request.includes("qlever.dev"))).searchParams.get("query");
  assert.match(sparql, /PREFIX wd:/);
  assert.match(sparql, /wdt:P161/);
  assert.match(sparql, /wdt:P57/);
});

test("WDQS is used when QLever rejects a query", async () => {
  const requests = [];
  const verifier = createLinkVerifier({
    fetchImpl: async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.includes("wbsearchentities")) return jsonResponse(wikidataCandidates(new URL(value).searchParams.get("search")));
      if (value.includes("qlever.dev")) return jsonResponse({ error: "down" }, 503);
      if (value.includes("query.wikidata.org")) return jsonResponse({ results: { bindings: [{
        film: { value: "http://www.wikidata.org/entity/Q20001199" },
        filmLabel: { value: "The Artist" },
        left: { value: "http://www.wikidata.org/entity/Q189422" },
        right: { value: "http://www.wikidata.org/entity/Q182021" },
      }] } });
      if (value.includes("wikipedia.org/w/api.php")) return jsonResponse({ query: { search: [] } });
      throw new Error(`Unexpected URL ${value}`);
    },
  });
  const result = await verifier.verify({ left: "Jean Dujardin", right: "Bérénice Bejo" });
  assert.equal(result.verdict, "CONFIRMED");
  assert.match(requests.find((request) => request.includes("query.wikidata.org")), /format=json/);
});

test("Wikipedia co-occurrence is probable and never silently confirmed", async () => {
  const verifier = createLinkVerifier({
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes("wbsearchentities")) return jsonResponse({ search: [] });
      if (value.includes("list=search")) return jsonResponse({ query: { search: [{ pageid: 7, title: "Film obscur", snippet: "Alice <span>et</span> Bob" }] } });
      if (value.includes("prop=pageprops%7Ccategories")) return jsonResponse({ query: { pages: { 7: { pageid: 7, pageprops: { wikibase_item: "Q700" }, categories: [{ title: "Catégorie:Film français sorti en 1999" }] } } } });
      if (value.includes("qlever.dev") || value.includes("query.wikidata.org")) return jsonResponse({ results: { bindings: [] } });
      throw new Error(`Unexpected URL ${value}`);
    },
  });
  const result = await verifier.verify({ left: "Alice Artiste", right: "Bob Artiste" });
  assert.equal(result.verdict, "PROBABLE");
  assert.equal(result.source, "wikipedia");
  assert.equal(result.evidence[0].snippet, "Alice et Bob");
  assert.equal(result.evidence[0].classification, "category-film");
});

test("a complete empty cascade returns NOT_FOUND while an outage returns UNKNOWN", async () => {
  const empty = createLinkVerifier({
    fetchImpl: async (url) => String(url).includes("wbsearchentities")
      ? jsonResponse({ search: [] })
      : jsonResponse({ query: { search: [] } }),
  });
  assert.equal((await empty.verify({ left: "Alice Artiste", right: "Bob Artiste" })).verdict, "NOT_FOUND");

  const unavailable = createLinkVerifier({ fetchImpl: async () => { throw new Error("offline"); } });
  const result = await unavailable.verify({ left: "Alice Artiste", right: "Bob Artiste" });
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.searchLinks.google.includes("Alice%20Artiste"), true);
});

test("TMDb confirmation takes priority and pair results are cached", async () => {
  let peopleCalls = 0;
  const person = (id, name) => ({
    name,
    externalIds: { tmdb: id },
    credits: [{ title: "Film commun", year: 2020, type: "movie", externalIds: { tmdbMovie: 99 } }],
  });
  const tmdb = {
    configured: true,
    getPerson: async (id) => {
      peopleCalls += 1;
      return person(Number(id), Number(id) === 1 ? "Alice" : "Bob");
    },
  };
  const verifier = createLinkVerifier({ tmdb, fetchImpl: async () => { throw new Error("should not fetch"); } });
  const first = await verifier.verify({ left: "Alice", right: "Bob", leftTmdbId: 1, rightTmdbId: 2 });
  const second = await verifier.verify({ left: "Bob", right: "Alice", leftTmdbId: 2, rightTmdbId: 1 });
  assert.equal(first.source, "tmdb");
  assert.equal(first.verdict, "CONFIRMED");
  assert.equal(second.cached, true);
  assert.equal(peopleCalls, 2);
  assert.equal(verifier.status().cacheHits, 1);
});

test("search links are encoded and invalid pairs are rejected", async () => {
  const links = createVerificationSearchLinks("Jean Dujardin", "Bérénice Bejo");
  assert.match(links.duckduckgo, /Jean%20Dujardin/);
  const verifier = createLinkVerifier({ networkEnabled: false });
  await assert.rejects(() => verifier.verify({ left: "Alice", right: " alice " }), /doivent être différents/);
  await assert.rejects(() => verifier.verify({ left: "A", right: "Bob" }), /requis/);
});

test("upstream concurrency is bounded instead of amplifying public traffic", async () => {
  let release;
  const heldResponse = new Promise((resolve) => { release = () => resolve(jsonResponse({ search: [] })); });
  let calls = 0;
  const verifier = createLinkVerifier({
    maxConcurrentUpstream: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return heldResponse;
      return jsonResponse({ search: [] });
    },
  });
  const first = verifier.verify({ left: "Alice Artiste", right: "Bob Artiste" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await verifier.verify({ left: "Carole Artiste", right: "David Artiste" });
  assert.equal(second.verdict, "UNKNOWN");
  assert.equal(verifier.status().upstream.rejected > 0, true);
  release();
  await first;
});

/* -----------------------------------------------------------------------------
   Le périmètre, jusque dans la cascade
   -------------------------------------------------------------------------- */

// TMDb appelle « movie » un documentaire d'archives. Deneuve et Moreau partageaient ainsi seize « films » qui
// étaient des portraits de Truffaut, de Demy ou de Belmondo — jamais un tournage commun.
const archiveDocumentary = { title: "Belmondo l’incorrigible", year: 2022, type: "movie", kind: "documentary", externalIds: { tmdbMovie: 1021162 } };
const sharedFilm = { title: "Le Dernier Métro", year: 1980, type: "movie", kind: "cinema", externalIds: { tmdbMovie: 1234 } };

function tmdbWithCredits(credits) {
  return {
    configured: true,
    getPerson: async (id) => ({ name: `Artiste ${id}`, externalIds: { tmdb: Number(id) }, credits }),
  };
}

test("a documentary is not a film until the table says it is", async () => {
  const tmdb = tmdbWithCredits([archiveDocumentary]);
  const offline = async () => { throw new Error("offline"); };

  const strict = createLinkVerifier({ tmdb, fetchImpl: offline });
  const refused = await strict.verify({ left: "Catherine Deneuve", right: "Jeanne Moreau", leftTmdbId: 1, rightTmdbId: 2 });
  assert.equal(refused.verdict, "UNKNOWN");
  assert.deepEqual(refused.films, []);

  const opened = createLinkVerifier({ tmdb, fetchImpl: offline });
  const accepted = await opened.verify({ left: "Catherine Deneuve", right: "Jeanne Moreau", leftTmdbId: 1, rightTmdbId: 2, scope: "documentary" });
  assert.equal(accepted.verdict, "CONFIRMED");
  assert.deepEqual(accepted.films.map((film) => film.title), ["Belmondo l’incorrigible"]);
});

test("a real film still holds the chain together, documentary or not", async () => {
  const verifier = createLinkVerifier({ tmdb: tmdbWithCredits([archiveDocumentary, sharedFilm]), fetchImpl: async () => { throw new Error("offline"); } });
  const result = await verifier.verify({ left: "Catherine Deneuve", right: "Gérard Depardieu", leftTmdbId: 1, rightTmdbId: 2 });
  assert.equal(result.verdict, "CONFIRMED");
  assert.deepEqual(result.films.map((film) => film.title), ["Le Dernier Métro"]);
});

test("two scopes are two questions, and never share a cached answer", async () => {
  let calls = 0;
  const tmdb = {
    configured: true,
    getPerson: async (id) => {
      calls += 1;
      return { name: `Artiste ${id}`, externalIds: { tmdb: Number(id) }, credits: [archiveDocumentary] };
    },
  };
  const verifier = createLinkVerifier({ tmdb, fetchImpl: async () => { throw new Error("offline"); } });
  const pair = { left: "Alice", right: "Bob", leftTmdbId: 1, rightTmdbId: 2 };
  assert.equal((await verifier.verify(pair)).verdict, "UNKNOWN");
  assert.equal((await verifier.verify({ ...pair, scope: "documentary" })).verdict, "CONFIRMED");
  assert.equal(verifier.status().cacheHits, 0);
  // La même question, elle, ne repart pas en ligne.
  assert.equal((await verifier.verify({ ...pair, scope: "documentary" })).cached, true);
  assert.equal(calls, 4);
});

test("Wikidata names the documentaries and the television films it cannot help but return", async () => {
  const bindings = [
    {
      film: { value: "http://www.wikidata.org/entity/Q1" },
      filmLabel: { value: "Portrait d’archives" },
      documentary: { value: "true" },
      television: { value: "false" },
      left: { value: "http://www.wikidata.org/entity/Q189422" },
      right: { value: "http://www.wikidata.org/entity/Q182021" },
    },
    {
      film: { value: "http://www.wikidata.org/entity/Q2" },
      filmLabel: { value: "Un vrai film" },
      documentary: { value: "false" },
      television: { value: "false" },
      left: { value: "http://www.wikidata.org/entity/Q189422" },
      right: { value: "http://www.wikidata.org/entity/Q182021" },
    },
  ];
  const requests = [];
  const verifier = createLinkVerifier({
    tmdb: { configured: false },
    fetchImpl: async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.includes("wbsearchentities")) return jsonResponse(wikidataCandidates(new URL(value).searchParams.get("search")));
      if (value.includes("qlever.dev")) return jsonResponse({ results: { bindings } });
      if (value.includes("wikipedia.org/w/api.php")) return jsonResponse({ query: { search: [] } });
      throw new Error(`Unexpected URL ${value}`);
    },
  });
  const result = await verifier.verify({ left: "Jean Dujardin", right: "Bérénice Bejo" });
  assert.equal(result.verdict, "CONFIRMED");
  assert.deepEqual(result.films.map((film) => film.title), ["Un vrai film"]);
  // La requête doit continuer de descendre la chaîne des sous-classes, sans quoi la moitié des vrais films
  // manquerait à l'appel : c'est à la lecture, et non au filtrage, que le documentaire est écarté.
  const sparql = new URL(requests.find((request) => request.includes("qlever.dev"))).searchParams.get("query");
  assert.match(sparql, /wdt:P31\/wdt:P279\* wd:Q11424/);
  assert.match(sparql, /EXISTS \{ \?film wdt:P31\/wdt:P279\* wd:Q93204 \}/);
  assert.match(sparql, /EXISTS \{ \?film wdt:P31\/wdt:P279\* wd:Q506240 \}/);
});
