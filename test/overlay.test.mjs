import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const overlay = JSON.parse(await readFile(new URL("../src/data/tmdb-overlay.json", import.meta.url)));

test("the published TMDb overlay is compact, referentially valid and free of legacy work IDs", () => {
  assert.equal(overlay.version, 2);
  assert.equal(overlay.people.length >= 100, true);
  assert.equal(overlay.failures.length, 0);
  assert.equal(new Set(overlay.works.map((work) => work.id)).size, overlay.works.length);
  const workIds = new Set(overlay.works.map((work) => work.id));
  const creditIds = overlay.people.flatMap((person) => person.credits ?? []);
  assert.equal(creditIds.every((creditId) => typeof creditId === "string" && workIds.has(creditId)), true);
  assert.equal(overlay.works.some((work) => work.externalIds?.tmdb !== undefined), false);
  assert.equal(overlay.stats.people, overlay.people.length);
  assert.equal(overlay.stats.works, overlay.works.length);
  assert.equal(overlay.stats.credits, creditIds.length);
});
