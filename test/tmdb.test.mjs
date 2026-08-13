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
  const results = await client.searchPeople("Jane");
  assert.equal(results[0].externalIds.tmdb, 12);
  assert.deepEqual(results[0].knownFor, ["A Film"]);
  assert.match(requestedUrl, /query=Jane/);
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
