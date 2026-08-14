// La nature d'une œuvre est ce qui décide si une liaison compte. Chaque cas repris ici vient d'une partie
// réellement jouée le 14 août 2026, où une émission de télévision a coûté une vie à un joueur qui criait au bluff
// — et qui avait raison.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTmdbCredit,
  classifyWikidataFilm,
  classifyWikipediaCategories,
  describeExtensions,
  isWorkInScope,
  kindsAreCompatible,
  normalizeExtensions,
  scopeFromExtensions,
  WORK_EXTENSIONS,
  WORK_KINDS,
  workKind,
} from "../src/game/work-kinds.js";

test("TMDb genres separate cinema from what only looks like cinema", () => {
  // 18 drame, 35 comédie : du cinéma.
  assert.equal(classifyTmdbCredit({ mediaType: "movie", genreIds: [18, 35] }), WORK_KINDS.CINEMA);
  // 99 documentaire — « Belmondo l'incorrigible », qui reliait Deneuve à Moreau et Moreau à Bourvil.
  assert.equal(classifyTmdbCredit({ mediaType: "movie", genreIds: [99] }), WORK_KINDS.DOCUMENTARY);
  // 10770 téléfilm : jamais sorti en salle.
  assert.equal(classifyTmdbCredit({ mediaType: "movie", genreIds: [10770, 18] }), WORK_KINDS.SERIES);
  // 10767 talk : « LEGEND », le plateau qui a éliminé un joueur.
  assert.equal(classifyTmdbCredit({ mediaType: "tv", genreIds: [10767] }), WORK_KINDS.SHOW);
  assert.equal(classifyTmdbCredit({ mediaType: "tv", genreIds: [35] }), WORK_KINDS.SERIES);
  // Une émission d'archives se réclame aussi du documentaire : c'est le plateau qui a réuni les invités.
  assert.equal(classifyTmdbCredit({ mediaType: "tv", genreIds: [99, 10764] }), WORK_KINDS.SHOW);
});

test("a credit without genres is admitted as unknown rather than guessed", () => {
  // Le catalogue publié avant cette version ne porte aucun genre : le nier viderait le jeu de ses films.
  assert.equal(classifyTmdbCredit({ mediaType: "movie", genreIds: [] }), WORK_KINDS.UNKNOWN);
  assert.equal(classifyTmdbCredit({ mediaType: "movie" }), WORK_KINDS.UNKNOWN);
  // Un support télévisé, lui, se sait sans le moindre genre.
  assert.equal(classifyTmdbCredit({ mediaType: "tv" }), WORK_KINDS.SERIES);
});

test("Wikidata and Wikipédia name the same natures", () => {
  assert.equal(classifyWikidataFilm({}), WORK_KINDS.CINEMA);
  assert.equal(classifyWikidataFilm({ documentary: true }), WORK_KINDS.DOCUMENTARY);
  assert.equal(classifyWikidataFilm({ television: true }), WORK_KINDS.SERIES);
  // « Film documentaire français » commence par « Film » : l'ancienne lecture n'y voyait qu'un film.
  assert.equal(classifyWikipediaCategories(["Film documentaire français sorti en 2016"]), WORK_KINDS.DOCUMENTARY);
  assert.equal(classifyWikipediaCategories(["Série télévisée française"]), WORK_KINDS.SERIES);
  assert.equal(classifyWikipediaCategories(["Film français sorti en 1966", "Comédie française"]), WORK_KINDS.CINEMA);
});

test("a stored kind outranks every guess, and a silent work falls back on its source", () => {
  assert.equal(workKind({ kind: WORK_KINDS.DOCUMENTARY, type: "movie", source: "lovable-recovery" }), WORK_KINDS.DOCUMENTARY);
  assert.equal(workKind({ type: "tv", externalIds: { tmdbTv: 42 } }), WORK_KINDS.SERIES);
  assert.equal(workKind({ type: "movie", source: "lovable-recovery" }), WORK_KINDS.CINEMA);
  assert.equal(workKind({ type: "movie", source: "tmdb" }), WORK_KINDS.UNKNOWN);
  assert.equal(workKind(null), WORK_KINDS.UNKNOWN);
});

test("the core scope plays cinema and the unnamed, never television", () => {
  const core = scopeFromExtensions(null);
  assert.equal(isWorkInScope({ kind: WORK_KINDS.CINEMA }, core), true);
  assert.equal(isWorkInScope({ kind: WORK_KINDS.UNKNOWN }, core), true);
  assert.equal(isWorkInScope({ kind: WORK_KINDS.DOCUMENTARY }, core), false);
  assert.equal(isWorkInScope({ kind: WORK_KINDS.SERIES }, core), false);
  assert.equal(isWorkInScope({ kind: WORK_KINDS.SHOW }, core), false);
});

test("each extension opens exactly one nature", () => {
  for (const extension of WORK_EXTENSIONS) {
    const scope = scopeFromExtensions({ [extension.id]: true });
    for (const other of WORK_EXTENSIONS) {
      assert.equal(scope.has(other.kind), other.id === extension.id, `${extension.id} ne doit ouvrir que ${extension.kind}`);
    }
  }
});

test("a save that predates the extensions plays the core scope", () => {
  assert.deepEqual(normalizeExtensions(undefined), normalizeExtensions({}));
  assert.deepEqual(normalizeExtensions("séries"), normalizeExtensions({}));
  // Une valeur bricolée n'ouvre rien : seul un vrai booléen ouvre une extension.
  assert.equal(normalizeExtensions({ series: "oui" }).series, false);
  assert.equal(normalizeExtensions({ series: true }).series, true);
  assert.deepEqual(describeExtensions({ series: true, shows: true }), ["Séries & téléfilms", "Émissions & plateaux"]);
  assert.deepEqual(describeExtensions(null), []);
});

test("only a named nature can contradict another", () => {
  assert.equal(kindsAreCompatible(WORK_KINDS.CINEMA, WORK_KINDS.UNKNOWN), true);
  assert.equal(kindsAreCompatible(WORK_KINDS.UNKNOWN, WORK_KINDS.SHOW), true);
  assert.equal(kindsAreCompatible(WORK_KINDS.CINEMA, WORK_KINDS.CINEMA), true);
  assert.equal(kindsAreCompatible(WORK_KINDS.CINEMA, WORK_KINDS.SERIES), false);
  assert.equal(kindsAreCompatible(WORK_KINDS.DOCUMENTARY, WORK_KINDS.CINEMA), false);
});
