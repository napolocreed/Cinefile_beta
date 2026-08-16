import test from "node:test";
import assert from "node:assert/strict";
import { createTmdbClient } from "../src/server/tmdb.js";

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test("TMDb search maps people without exposing credentials", async () => {
  let requestedUrl;
  let requestedHeaders;
  const client = createTmdbClient({ token: "secret-token", fetchImpl: async (url, options) => {
    requestedUrl = String(url);
    requestedHeaders = options.headers;
    return response({ results: [{ id: 12, name: "Jane Doe", known_for_department: "Acting", profile_path: "/jane.jpg", popularity: 9, known_for: [{ title: "A Film" }] }] });
  } });
  const results = await client.searchPeople("Jane", { includeAdult: true });
  assert.equal(results[0].externalIds.tmdb, 12);
  assert.deepEqual(results[0].knownFor, ["A Film"]);
  assert.match(requestedUrl, /query=Jane/);
  assert.match(requestedUrl, /include_adult=true/);
  assert.doesNotMatch(requestedUrl, /secret-token/);
  assert.equal(requestedHeaders.Authorization, "Bearer secret-token");
});

test("TMDb person hydration combines cast and crew credits deterministically", async () => {
  const client = createTmdbClient({ apiKey: "api-key", fetchImpl: async () => response({
    id: 12,
    name: "Jane Doe",
    also_known_as: ["J. Doe"],
    birthday: "1988-04-02",
    profile_path: null,
    popularity: 5,
    external_ids: { imdb_id: "nm0012" },
    combined_credits: {
      cast: [{ id: 7, media_type: "movie", title: "A Film", original_title: "A Film", release_date: "2024-01-01" }],
      crew: [{ id: 7, media_type: "movie", title: "A Film", original_title: "A Film", release_date: "2024-01-01", department: "Production" }],
    },
  }) });
  const person = await client.getPerson(12);
  assert.equal(person.birthYear, 1988);
  assert.equal(person.credits.length, 1);
  assert.deepEqual(person.credits[0].roles, ["acting", "production"]);
  assert.equal(person.credits[0].externalIds.tmdbMovie, 7);
  assert.equal(person.credits[0].externalIds.tmdb, undefined);
  assert.equal(person.externalIds.imdb, "nm0012");
});

test("credit genres travel with the work, because nothing else separates a documentary from a film", async () => {
  const client = createTmdbClient({ apiKey: "api-key", fetchImpl: async () => response({
    id: 13,
    name: "Jane Doe",
    combined_credits: {
      cast: [
        { id: 8, media_type: "movie", title: "Un film", release_date: "2020-01-01", genre_ids: [18, 35] },
        { id: 9, media_type: "movie", title: "Un portrait", release_date: "2022-01-01", genre_ids: [99] },
        { id: 10, media_type: "tv", name: "Un plateau", first_air_date: "2019-01-01", genre_ids: [10767] },
      ],
      // TMDb ne répète pas toujours les genres sur la ligne technique : la nature déjà nommée ne doit pas y
      // retomber à l'inconnu.
      crew: [{ id: 9, media_type: "movie", title: "Un portrait", release_date: "2022-01-01", department: "Sound" }],
    },
  }) });
  const person = await client.getPerson(13);
  const kinds = Object.fromEntries(person.credits.map((work) => [work.title, work.kind]));
  assert.deepEqual(kinds, { "Un film": "cinema", "Un portrait": "documentary", "Un plateau": "show" });
});

// La garde du rattrapage portait sur `kind === UNKNOWN`, structurellement inatteignable pour la télévision : une
// ligne tv sans genres rend déjà « série ». Un talk-show dont la ligne muette arrivait en premier restait donc
// classé série, et passait le périmètre d'une table qui avait ouvert les séries mais pas les plateaux.
test("a work's nature does not depend on the order of its credit lines", async () => {
  const person = (castFirst) => ({
    id: 5,
    name: "Invité",
    known_for_department: "Acting",
    combined_credits: {
      cast: [castFirst
        ? { id: 77, media_type: "tv", name: "Le Grand Plateau", first_air_date: "2019-01-01" }
        : { id: 77, media_type: "tv", name: "Le Grand Plateau", first_air_date: "2019-01-01", genre_ids: [10767] }],
      crew: [castFirst
        ? { id: 77, media_type: "tv", name: "Le Grand Plateau", first_air_date: "2019-01-01", genre_ids: [10767], department: "Production" }
        : { id: 77, media_type: "tv", name: "Le Grand Plateau", first_air_date: "2019-01-01", department: "Production" }],
    },
  });
  for (const castFirst of [true, false]) {
    const client = createTmdbClient({ token: "t", fetchImpl: async () => response(person(castFirst)) });
    const hydrated = await client.getPerson(5);
    assert.equal(hydrated.credits[0].kind, "show", `ligne avec genres en ${castFirst ? "second" : "premier"}`);
    assert.deepEqual(hydrated.credits[0].genreIds, [10767]);
  }
});
