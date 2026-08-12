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
