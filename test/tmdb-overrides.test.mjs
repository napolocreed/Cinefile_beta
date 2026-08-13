import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [snapshot, overrides] = await Promise.all([
  readFile(new URL("../src/data/cinema-knowledge.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/tmdb-person-overrides.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("manual TMDb identity overrides are unique, documented and point to local people", () => {
  assert.equal(overrides.version, 1);
  assert.equal(new Set(overrides.matches.map((entry) => entry.localPersonId)).size, overrides.matches.length);
  assert.equal(new Set(overrides.matches.map((entry) => entry.tmdbId)).size, overrides.matches.length);
  const localIds = new Set(snapshot.people.map((person) => person.id));
  assert.equal(overrides.matches.every((entry) => localIds.has(entry.localPersonId)), true);
  assert.equal(overrides.matches.every((entry) => Number.isInteger(entry.tmdbId) && entry.tmdbId > 0 && entry.reason.length >= 20), true);
});
