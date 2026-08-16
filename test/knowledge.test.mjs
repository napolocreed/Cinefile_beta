import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/game/database.js";
import { parseYear } from "../src/game/identity.js";

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

// La lecture d'année acceptait une simple espace à gauche et la fin de chaîne à droite : tout titre finissant par
// un nombre à quatre chiffres devenait une année. 64 des 69 œuvres datées du snapshot livré étaient fausses, et la
// fusion refusant tout rapprochement dès que deux années se contredisent, le crédit TMDb du même film créait une
// œuvre de plus — la liaison cessait d'être prouvable hors ligne.
test("a number inside a title is not a release year", () => {
  for (const title of ["Blade Runner 2049", "Wonder Woman 1984", "Camille Claudel 1915", "Cherry 2000", "Airport 1975"]) {
    assert.equal(parseYear(title), null, title);
  }
  // Une année explicitement délimitée reste lue.
  assert.equal(parseYear("Titanic (1997)"), 1997);
  assert.equal(parseYear("Le Voyage [1985]"), 1985);
  assert.equal(parseYear("Madame Husson's Rose (film, 1932)"), 1932);
});

// Le snapshot livré doit refléter cette lecture : sans quoi les œuvres restent datées à tort et la fusion continue
// de les refuser.
test("the shipped snapshot only dates works whose title says so", () => {
  const dated = snapshot.works.filter((work) => work.year);
  assert.equal(dated.length > 0, true);
  for (const work of dated) assert.equal(parseYear(work.title), work.year, work.title);
});

// Les tests du snapshot n'assertaient que le JSON brut : la corruption apparaissait au CHARGEMENT, quand une fusion
// perdait l'identifiant qu'elle absorbait et que le crédit orphelin devenait une œuvre titrée « work_0g8sb5b ».
// Cette garde se place là où le défaut vivait — sur la base construite, pas sur le fichier.
test("the built database never turns an identifier into a work title", () => {
  const database = createDatabase(snapshot);
  const identifiers = database.works.filter((work) => /^(?:work|person)_[0-9a-z]{7}$|^tmdb(?:-movie|-tv)?:\d+$/.test(work.title));
  assert.deepEqual(identifiers.map((work) => work.title), []);
  // Et aucune filmographie ne porte un identifiant en guise de titre de film.
  const corrupted = database.people.filter((person) => (person.films ?? []).some((film) => /^work_[0-9a-z]{7}$/.test(film)));
  assert.deepEqual(corrupted.map((person) => person.name), []);
});
