// Le catalogue publié est un fichier : il ne sait que ce que la synchronisation y a écrit le jour où elle est
// passée. Les éditions antérieures aux natures d'œuvres ne peuvent donc pas dire qu'un crédit est un documentaire,
// et le jeu doit alors le laisser passer faute de mieux. Quand TMDb répond, on préfère la fiche fraîche.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublishedCatalog } from "../src/server/published-catalog.js";

const overlay = {
  version: 2,
  people: [{ localPersonId: "person_alice", name: "Alice", externalIds: { tmdb: 42 }, credits: ["tmdb-movie:7"] }],
  works: [{ id: "tmdb-movie:7", title: "Un portrait", year: 2022, type: "movie", externalIds: { tmdbMovie: 7 }, source: "tmdb" }],
  stats: { people: 1, works: 1, credits: 1 },
};

async function overlayUrl(name) {
  const path = join(tmpdir(), `cinefil-${name}-${process.pid}.json`);
  await writeFile(path, JSON.stringify(overlay));
  return pathToFileURL(path);
}

test("a catalogue that cannot name its natures is completed from TMDb", async () => {
  const tmdb = {
    configured: true,
    getPerson: async (id) => {
      assert.equal(id, 42);
      return { name: "Alice TMDb", credits: [{ id: "tmdb-movie:7", title: "Un portrait", year: 2022, type: "movie", kind: "documentary", externalIds: { tmdbMovie: 7 }, source: "tmdb" }] };
    },
  };
  const catalog = createPublishedCatalog({ overlayUrl: await overlayUrl("fresh"), tmdb });
  const person = await catalog.getPerson("person_alice");
  // L'identité locale prime : la partie a ce nom en main, et le renommer casserait la chaîne en cours.
  assert.equal(person.name, "Alice");
  assert.equal(person.credits[0].kind, "documentary");
});

test("a quota reached is not an empty filmography", async () => {
  const tmdb = { configured: true, getPerson: async () => { throw new Error("429"); } };
  const catalog = createPublishedCatalog({ overlayUrl: await overlayUrl("quota"), tmdb });
  const person = await catalog.getPerson("person_alice");
  assert.equal(person.credits.length, 1);
  assert.equal(person.credits[0].kind, undefined);
});

// Le test ci-dessus ne couvre que le jet. Or getPerson rend toujours un tableau — `payload.combined_credits?.cast
// ?? []` — donc une réponse 200 sans combined_credits donnait credits: [], qui passait le `??` et vidait la fiche
// publiée sans qu'aucun catch ne se déclenche : l'artiste ressortait injouable.
test("an empty remote filmography is ignored, not published", async () => {
  const tmdb = { configured: true, getPerson: async () => ({ name: "Alice", credits: [] }) };
  const catalog = createPublishedCatalog({ overlayUrl: await overlayUrl("vide"), tmdb });
  const person = await catalog.getPerson("person_alice");
  assert.equal(person.credits.length, 1);
});

test("without TMDb the published catalogue answers on its own", async () => {
  const catalog = createPublishedCatalog({ overlayUrl: await overlayUrl("local"), tmdb: { configured: false } });
  assert.equal((await catalog.getPerson("person_alice")).credits[0].title, "Un portrait");
  assert.equal(await catalog.getPerson("person_absent"), null);
});

test("a catalogue that already names its natures is served untouched", async () => {
  let calls = 0;
  const named = {
    ...overlay,
    works: [{ ...overlay.works[0], kind: "cinema" }],
  };
  const path = join(tmpdir(), `cinefil-named-${process.pid}.json`);
  await writeFile(path, JSON.stringify(named));
  const catalog = createPublishedCatalog({
    overlayUrl: pathToFileURL(path),
    tmdb: { configured: true, getPerson: async () => { calls += 1; return { credits: [] }; } },
  });
  assert.equal((await catalog.getPerson("person_alice")).credits[0].kind, "cinema");
  assert.equal(calls, 0);
});
