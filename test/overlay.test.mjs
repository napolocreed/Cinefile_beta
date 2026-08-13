import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeText } from "../src/game/identity.js";

const [overlay, snapshot, overrides] = await Promise.all([
  readFile(new URL("../src/data/tmdb-overlay.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/cinema-knowledge.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/tmdb-person-overrides.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("the published TMDb overlay is compact, referentially valid and free of legacy work IDs", () => {
  assert.equal(overlay.version, 2);
  assert.equal(overlay.people.length, snapshot.people.length);
  assert.equal(overlay.failures.length, 0);
  assert.equal(new Set(overlay.people.map((person) => person.localPersonId)).size, overlay.people.length);
  assert.equal(new Set(overlay.people.map((person) => person.externalIds?.tmdb)).size, overlay.people.length);
  assert.deepEqual(new Set(overlay.people.map((person) => person.localPersonId)), new Set(snapshot.people.map((person) => person.id)));
  assert.equal(new Set(overlay.works.map((work) => work.id)).size, overlay.works.length);
  const workIds = new Set(overlay.works.map((work) => work.id));
  const creditIds = overlay.people.flatMap((person) => person.credits ?? []);
  assert.equal(creditIds.every((creditId) => typeof creditId === "string" && workIds.has(creditId)), true);
  assert.equal(overlay.works.some((work) => work.externalIds?.tmdb !== undefined), false);
  assert.equal(overlay.stats.people, overlay.people.length);
  assert.equal(overlay.stats.works, overlay.works.length);
  assert.equal(overlay.stats.credits, creditIds.length);
});

test("every automatic TMDb identity has film evidence and every manual identity is registered", () => {
  const localPeople = new Map(snapshot.people.map((person) => [person.id, person]));
  const localWorks = new Map(snapshot.works.map((work) => [work.id, work]));
  const remoteWorks = new Map(overlay.works.map((work) => [work.id, work]));
  const overridesByLocalId = new Map(overrides.matches.map((entry) => [entry.localPersonId, entry]));
  for (const person of overlay.people) {
    const override = overridesByLocalId.get(person.localPersonId);
    if (override) {
      assert.equal(person.externalIds.tmdb, override.tmdbId);
      continue;
    }
    const localTitles = new Set(localPeople.get(person.localPersonId).credits
      .flatMap((workId) => {
        const work = localWorks.get(workId);
        return work ? [work.title, work.originalTitle, ...(work.aliases ?? [])] : [];
      })
      .map(normalizeText)
      .filter(Boolean));
    const remoteTitles = new Set(person.credits
      .flatMap((workId) => {
        const work = remoteWorks.get(workId);
        return work ? [work.title, work.originalTitle, ...(work.aliases ?? [])] : [];
      })
      .map(normalizeText)
      .filter(Boolean));
    assert.equal([...localTitles].some((title) => remoteTitles.has(title)), true, `${localPeople.get(person.localPersonId).name} lacks film evidence`);
  }
});
