import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDatabase, normalizeText } from "../src/game/database.js";

const data = JSON.parse(await readFile(new URL("../src/data/cinema-database.json", import.meta.url)));
const database = createDatabase(data);

test("normalisation is accent and punctuation insensitive", () => {
  assert.equal(normalizeText("  Timothée  Chalamet! "), "timothee chalamet");
  assert.equal(database.findActor("timothee chalamet")?.name, "Timothée Chalamet");
});

test("the recovered database validates known film links", () => {
  assert.equal(database.sharedFilms("Leonardo DiCaprio", "Kate Winslet").includes("Titanic"), true);
  assert.equal(database.sharedFilms("Leonardo DiCaprio", "Tom Hanks").includes("Catch Me If You Can"), true);
  assert.equal(database.sharedFilms("Leonardo DiCaprio", "Nobody").length, 0);
});

test("autocomplete excludes used actors and respects the French theme", () => {
  assert.deepEqual(database.searchActors("timothee", { themeId: "classic" }), ["Timothée Chalamet"]);
  assert.deepEqual(database.searchActors("timothee", { themeId: "fr" }), ["Timothée Chalamet"]);
  assert.deepEqual(database.searchActors("leonardo", { themeId: "fr" }), []);
  assert.deepEqual(database.searchActors("leonardo", { excluded: ["Leonardo DiCaprio"] }), []);
});

test("TMDb movie and TV identifiers occupy distinct namespaces", () => {
  const freshDatabase = createDatabase({ people: [], works: [] });
  const movie = freshDatabase.upsertWork({ title: "Movie Seven", type: "movie", externalIds: { tmdbMovie: 7 } }, { source: "tmdb" });
  const series = freshDatabase.upsertWork({ title: "Series Seven", type: "tv", externalIds: { tmdbTv: 7 } }, { source: "tmdb" });
  assert.notEqual(movie.id, series.id);
  assert.equal(freshDatabase.stats().works, 2);
});

test("a higher-priority canonical name preserves the previous name as an alias", () => {
  const database = createDatabase({ people: [{ id: "person:42", name: "Stage Name", credits: [], source: "snapshot" }], works: [] });
  const person = database.upsertPerson({ id: "person:42", name: "Canonical Name", credits: [] }, { source: "tmdb" });
  assert.equal(person.name, "Canonical Name");
  assert.equal(person.aliases.includes("Stage Name"), true);
  assert.equal(database.findActor("Stage Name")?.id, "person:42");
});

/* -----------------------------------------------------------------------------
   Le périmètre des liaisons
   -------------------------------------------------------------------------- */

// Le snapshot embarqué porte 41 845 œuvres sans année : les rapprocher par le titre seul est la règle, sans quoi
// aucun crédit TMDb ne retrouverait jamais le film que la reprise Lovable connaissait déjà. C'est par là que la
// série « Beau geste » (tmdbTv 219282) est venue se ranger dans le film « Beau Geste » — dont elle a hérité le
// type movie, ce qui lui a fait passer le filtre des films communs sans que personne ne puisse la voir.
function snapshotWithFilm(title) {
  return {
    people: [
      { id: "person_left", name: "Gauche", credits: ["work_film"], source: "lovable-recovery" },
      { id: "person_right", name: "Droite", credits: ["work_film"], source: "lovable-recovery" },
    ],
    works: [{ id: "work_film", title, originalTitle: null, aliases: [], year: null, type: "movie", kind: "cinema", externalIds: {}, source: "lovable-recovery" }],
  };
}

test("a series never merges into the yearless film that shares its title", () => {
  const database = createDatabase(snapshotWithFilm("Beau Geste"));
  const series = database.upsertWork(
    { id: "tmdb-tv:219282", title: "Beau geste", year: 2023, type: "tv", kind: "series", externalIds: { tmdbTv: 219282 } },
    { source: "tmdb" },
  );
  assert.notEqual(series.id, "work_film");
  assert.equal(series.type, "tv");
  assert.equal(database.findWork("work_film").type, "movie");
  assert.equal(database.findWork("work_film").kind, "cinema");
});

test("a documentary never merges into the yearless film that shares its title", () => {
  const database = createDatabase(snapshotWithFilm("Belmondo l’incorrigible"));
  const documentary = database.upsertWork(
    { id: "tmdb-movie:1021162", title: "Belmondo l’incorrigible", year: 2022, type: "movie", kind: "documentary", externalIds: { tmdbMovie: 1021162 } },
    { source: "tmdb" },
  );
  assert.notEqual(documentary.id, "work_film");
  assert.equal(documentary.kind, "documentary");
});

test("a credit of the same nature still completes the film the snapshot already knew", () => {
  // Le garde-fou ne doit pas casser ce qui marchait : « La Grande Vadrouille » sans année doit toujours accueillir
  // sa fiche TMDb, sinon le catalogue se dédouble à chaque enrichissement.
  const database = createDatabase(snapshotWithFilm("La Grande Vadrouille"));
  const film = database.upsertWork(
    { title: "La Grande Vadrouille", year: 1966, type: "movie", kind: "cinema", externalIds: { tmdbMovie: 8290 } },
    { source: "tmdb" },
  );
  assert.equal(film.id, "work_film");
  assert.equal(film.year, 1966);
  assert.equal(database.stats().works, 1);
});

test("an unnamed credit still completes a known film, and takes its nature from it", () => {
  // Un catalogue publié sans genres ne dit rien de la nature : il ne doit pas pour autant dédoubler les fiches.
  const database = createDatabase(snapshotWithFilm("Le Corniaud"));
  const film = database.upsertWork({ title: "Le Corniaud", year: 1965, type: "movie", externalIds: { tmdbMovie: 25866 } }, { source: "tmdb" });
  assert.equal(film.id, "work_film");
  assert.equal(film.kind, "cinema");
});

test("an enriched credit renames the nature a silent one had left unknown", () => {
  const database = createDatabase({ people: [], works: [] });
  const silent = database.upsertWork({ id: "tmdb-movie:4033", title: "Vivement Truffaut", year: 1985, type: "movie", externalIds: { tmdbMovie: 4033 } }, { source: "tmdb" });
  assert.equal(silent.kind, "unknown");
  const named = database.upsertWork({ id: "tmdb-movie:4033", title: "Vivement Truffaut", year: 1985, type: "movie", kind: "documentary", externalIds: { tmdbMovie: 4033 } }, { source: "tmdb" });
  assert.equal(named.id, silent.id);
  assert.equal(database.findWork(silent.id).kind, "documentary");
});

test("shared films answer the scope the game asked for", () => {
  const database = createDatabase({
    people: [
      { id: "person_left", name: "Gauche", credits: ["work_cinema", "work_doc", "work_show"], source: "snapshot" },
      { id: "person_right", name: "Droite", credits: ["work_cinema", "work_doc", "work_show"], source: "snapshot" },
    ],
    works: [
      { id: "work_cinema", title: "Un film", type: "movie", kind: "cinema", source: "snapshot" },
      { id: "work_doc", title: "Un documentaire", type: "movie", kind: "documentary", source: "snapshot" },
      { id: "work_show", title: "Un plateau", type: "tv", kind: "show", source: "snapshot" },
    ],
  });
  assert.deepEqual(database.sharedFilms("Gauche", "Droite"), ["Un film"]);
  assert.deepEqual(database.sharedFilms("Gauche", "Droite", "classic", { extensions: { documentaries: true } }), ["Un film", "Un documentaire"]);
  assert.deepEqual(
    database.sharedFilms("Gauche", "Droite", "classic", { extensions: { documentaries: true, shows: true } }),
    ["Un film", "Un documentaire", "Un plateau"],
  );
});
