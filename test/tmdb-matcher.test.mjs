import test from "node:test";
import assert from "node:assert/strict";
import { resolveTmdbCandidate } from "../src/server/tmdb-matcher.js";

const worksById = new Map([
  ["work:a", { title: "Film A", aliases: [] }],
  ["work:b", { title: "Film B", aliases: [] }],
]);
const localPerson = { name: "Alice Example", credits: ["work:a", "work:b"] };

test("a renamed TMDb identity is accepted only with unique filmography overlap", async () => {
  const candidates = [
    { name: "Alice Example", externalIds: { tmdb: 84 } },
    { name: "Alice Example-Smith", externalIds: { tmdb: 42 } },
  ];
  const people = new Map([
    [42, { name: "Alice Example-Smith", aliases: [], popularity: 2, credits: [{ title: "Film A" }, { title: "Film B" }] }],
    [84, { name: "Alice Example", aliases: [], popularity: 8, credits: [{ title: "Unrelated" }] }],
  ]);
  const resolved = await resolveTmdbCandidate({ localPerson, candidates, worksById, getPerson: async (id) => people.get(id) });
  assert.equal(resolved.person, people.get(42));
  assert.equal(resolved.matchedBy, "tmdb-search-credit-overlap");
});

test("non-exact TMDb candidates stay in review when their filmography score is tied", async () => {
  const candidates = [
    { name: "Alice One", externalIds: { tmdb: 1 } },
    { name: "Alice Two", externalIds: { tmdb: 2 } },
  ];
  const getPerson = async (id) => ({ name: `Alice ${id}`, aliases: [], credits: [{ title: "Film A" }, { title: "Film B" }] });
  await assert.rejects(
    resolveTmdbCandidate({ localPerson, candidates, worksById, getPerson }),
    /recouvrement filmographique décisif/,
  );
});
