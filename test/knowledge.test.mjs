import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/game/database.js";

const [snapshot, synonyms, quality, mergeLog] = await Promise.all([
  readFile(new URL("../src/data/cinema-knowledge.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/cinema-synonyms.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/cinema-quality.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../src/data/cinema-merge-log.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("the canonical snapshot has unique IDs and no dangling credits", () => {
  assert.equal(snapshot.version, 2);
  assert.equal(new Set(snapshot.people.map((person) => person.id)).size, snapshot.people.length);
  assert.equal(new Set(snapshot.works.map((work) => work.id)).size, snapshot.works.length);
  const workIds = new Set(snapshot.works.map((work) => work.id));
  assert.equal(snapshot.people.every((person) => person.credits.every((workId) => workIds.has(workId))), true);
  assert.equal(quality.snapshotId, snapshot.snapshotId);
});

test("every automatic merge is logged and reversible", () => {
  assert.equal(mergeLog.entries.length, quality.automaticMerges + quality.curatedMerges);
  assert.equal(mergeLog.entries.every((entry) => entry.reversible && entry.canonicalId && entry.merged.length), true);
});

test("curated person and work aliases resolve to their canonical identities", () => {
  const database = createDatabase(snapshot, { synonyms });
  assert.equal(database.findActor("The Rock")?.name, "Dwayne Johnson");
  assert.equal(database.findActor("DiCaprio, Leonardo")?.name, "Leonardo DiCaprio");
  assert.equal(database.findActor("Pink")?.name, "P!nk");
  assert.equal(database.findActor("Samir Nasseri")?.id, database.findActor("Samy Naceri")?.id);
  assert.equal(database.sharedFilms("Leonardo DiCaprio", "Tom Hanks").includes("Arrête-moi si tu peux"), true);
});

test("uncertain accent-only work matches stay separated for human review", () => {
  assert.equal(quality.reviewCandidates > 0, true);
  const candidate = quality.unresolvedTitleCandidates.find((group) => group.some((work) => work.title === "A demain"));
  assert.equal(candidate?.length, 2);
  assert.notEqual(candidate[0].id, candidate[1].id);
});
