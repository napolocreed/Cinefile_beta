import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTmdbCast, parseYearRange } from "../scripts/import-tmdb-cast.mjs";
import { buildPortraitIndex } from "../scripts/build-portraits.mjs";
import { nameKeys, normalizeText, stableId, strictIdentityKey } from "../src/game/identity.js";

const SNAPSHOT_ID = "snapshot_fixture";
const IMAGE_ROOT = "https://image.tmdb.org/t/p/w185";

function localWork(id, title, year = null) {
  return { id, title, originalTitle: null, aliases: [], year, type: "movie", externalIds: {}, source: "lovable-recovery" };
}

function localPerson(id, name, credits, aliases = []) {
  return { id, name, aliases, roles: ["acting"], tags: ["fr"], birthYear: null, deathYear: null, profilePath: null, popularity: credits.length, externalIds: {}, credits, source: "lovable-recovery" };
}

function overlayPerson(localPersonId, tmdbId, name, credits) {
  return { id: `tmdb:${tmdbId}`, name, aliases: [], roles: ["acting"], tags: [], birthYear: null, deathYear: null, profilePath: `${IMAGE_ROOT}/known${tmdbId}.jpg`, popularity: 5, externalIds: { tmdb: tmdbId }, credits, source: "tmdb", localPersonId, matchedBy: "normalized-exact-credit-overlap", syncedAt: "2026-08-01T00:00:00.000Z" };
}

function overlayWork(tmdbId, title, year) {
  return { id: `tmdb-movie:${tmdbId}`, title, originalTitle: title, aliases: [], year, type: "movie", externalIds: { tmdbMovie: tmdbId }, source: "tmdb", roles: ["acting"] };
}

function baseSnapshot() {
  const people = [
    localPerson("person_cassel", "Vincent Cassel", ["work_lahaine"]),
    localPerson("person_dujardin", "Jean Dujardin", ["work_oss117"], ["Dujardin, Jean"]),
  ];
  const works = [localWork("work_lahaine", "La Haine"), localWork("work_oss117", "OSS 117 : Le Caire, nid d’espions"), localWork("work_lesens", "Le Sens de la fête")];
  return {
    version: 2,
    snapshotId: SNAPSHOT_ID,
    generatedAt: "2026-08-01T00:00:00.000Z",
    locale: "fr-FR",
    sources: [{ id: "lovable-recovery", importedAt: "2026-08-01T00:00:00.000Z" }],
    people,
    works,
    mergeLog: [],
    quality: { version: 1, snapshotId: SNAPSHOT_ID, people: people.length, works: works.length, credits: 2, aliases: 1, automaticMerges: 0, curatedMerges: 0, reviewCandidates: 0, orphanWorks: 1, peopleWithoutCredits: 0 },
  };
}

function baseOverlay() {
  const people = [overlayPerson("person_cassel", 1640, "Vincent Cassel", ["tmdb-movie:406"]), overlayPerson("person_dujardin", 20387, "Jean Dujardin", ["tmdb-movie:11072"])];
  const works = [overlayWork(406, "La Haine", 1995), overlayWork(11072, "OSS 117 : Le Caire, nid d’espions", 2006)];
  return {
    version: 2,
    baseSnapshotId: SNAPSHOT_ID,
    generatedAt: "2026-08-01T00:00:00.000Z",
    refreshAfterDays: 60,
    people,
    failures: [],
    stats: { people: people.length, works: works.length, credits: 2 },
    works,
  };
}

function movieCredit(id, title, year, mediaType = "movie") {
  return mediaType === "tv"
    ? { id, media_type: "tv", name: title, original_name: title, first_air_date: `${year}-01-01` }
    : { id, media_type: "movie", title, original_title: title, release_date: `${year}-03-08` };
}

function personPayload({ id, name, alsoKnownAs = [], profilePath = null, credits = [], imdb = null, popularity = 7 }) {
  return {
    id,
    name,
    also_known_as: alsoKnownAs,
    birthday: "1979-05-05",
    deathday: null,
    known_for_department: "Acting",
    profile_path: profilePath,
    popularity,
    external_ids: imdb ? { imdb_id: imdb } : {},
    combined_credits: { cast: credits, crew: [] },
  };
}

// TMDb is unreachable from the test runner and from the sandbox: every payload below is written from the documented
// shapes of /discover/movie, /movie/{id}/credits and /person/{id}?append_to_response=combined_credits,external_ids.
const FIXTURES = {
  "discover:2017:1": { page: 1, results: [{ id: 400_001, title: "Le Sens de la fête", release_date: "2017-09-27", popularity: 31.4, vote_count: 1_780 }] },
  "discover:2019:1": { page: 1, results: [{ id: 400_002, title: "Deux moi", release_date: "2019-09-11", popularity: 12.2, vote_count: 420 }] },
  "credits:400001": {
    id: 400_001,
    cast: [
      { id: 1_640, name: "Vincent Cassel", original_name: "Vincent Cassel", known_for_department: "Acting", order: 0, adult: false },
      { id: 500_001, name: "jean dujardin", original_name: "Jean Dujardin", known_for_department: "Acting", order: 1, adult: false },
      { id: 500_002, name: "Pio Marmaï", original_name: "Pio Marmaï", known_for_department: "Acting", order: 2, adult: false },
      { id: 500_003, name: "Alban Ivanov", original_name: "Alban Ivanov", known_for_department: "Acting", order: 3, adult: false },
      { id: 500_004, name: "Chef Opérateur", original_name: "Chef Opérateur", known_for_department: "Camera", order: 4, adult: false },
      { id: 500_005, name: "Silhouette Finale", original_name: "Silhouette Finale", known_for_department: "Acting", order: 42, adult: false },
    ],
  },
  "credits:400002": {
    id: 400_002,
    cast: [
      { id: 500_002, name: "Pio Marmaï", original_name: "Pio Marmaï", known_for_department: "Acting", order: 0, adult: false },
      { id: 500_006, name: "Camille Chamoux", original_name: "Camille Chamoux", known_for_department: "Acting", order: 1, adult: false },
      { id: 500_007, name: "Voix Off", original_name: "Voix Off", known_for_department: "Acting", order: 2, adult: false },
      { id: 500_008, name: "Léa Bertrand", original_name: "Léa Bertrand", known_for_department: "Acting", order: 3, adult: false },
    ],
  },
  "person:500002": personPayload({
    id: 500_002,
    name: "Pio Marmaï",
    alsoKnownAs: ["Pio Marmai", "Пио Мармай"],
    profilePath: "/marmai7.jpg",
    imdb: "nm2153663",
    credits: [movieCredit(400_001, "Le Sens de la fête", 2017), movieCredit(400_003, "Ce qui nous lie", 2017), movieCredit(700_001, "Une série française", 2021, "tv")],
  }),
  "person:500003": personPayload({ id: 500_003, name: "Alban Ivanov", profilePath: "/ivanov-2024.jpg", credits: [movieCredit(400_001, "Le Sens de la fête", 2017)] }),
  "person:500006": personPayload({ id: 500_006, name: "Camille Chamoux", profilePath: "/chamoux9.png", credits: [movieCredit(400_002, "Deux moi", 2019), movieCredit(400_004, "Larguées", 2018)] }),
  "person:500007": personPayload({ id: 500_007, name: "Voix Off", credits: [movieCredit(700_002, "Feuilleton du soir", 2020, "tv")] }),
  "person:500008": personPayload({ id: 500_008, name: "Léa Bertrand", alsoKnownAs: ["Bertrand, Léa", "Léa B. Bertrand", "Lea Bertrand"], profilePath: "/bertrand4.jpg", credits: [movieCredit(400_002, "Deux moi", 2019)] }),
};

function fixtureFetch({ calls = [], fixtures = FIXTURES } = {}) {
  return async (url) => {
    const target = new URL(String(url));
    calls.push(target.pathname);
    let key = null;
    if (target.pathname === "/3/discover/movie") key = `discover:${String(target.searchParams.get("primary_release_date.gte")).slice(0, 4)}:${target.searchParams.get("page")}`;
    const credits = target.pathname.match(/^\/3\/movie\/(\d+)\/credits$/);
    if (credits) key = `credits:${credits[1]}`;
    const person = target.pathname.match(/^\/3\/person\/(\d+)$/);
    if (person) key = `person:${person[1]}`;
    if (key?.startsWith("discover:")) return { ok: true, status: 200, json: async () => fixtures[key] ?? { page: 1, results: [] } };
    if (!key || !fixtures[key]) return { ok: false, status: 404, json: async () => ({ status_message: "not found" }) };
    return { ok: true, status: 200, json: async () => fixtures[key] };
  };
}

async function workspace({ snapshot = baseSnapshot(), overlay = baseOverlay() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cinefil-import-"));
  const snapshotPath = join(directory, "cinema-knowledge.json");
  const overlayPath = join(directory, "tmdb-overlay.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  await writeFile(overlayPath, `${JSON.stringify(overlay)}\n`);
  return { directory, snapshotPath, overlayPath };
}

async function runImport(paths, options = {}) {
  const calls = [];
  const report = await importTmdbCast({
    snapshotPath: paths.snapshotPath,
    overlayPath: paths.overlayPath,
    snapshotOutputPath: paths.snapshotPath,
    overlayOutputPath: paths.overlayPath,
    token: "fixture-token",
    fetchImpl: fixtureFetch({ calls, fixtures: options.fixtures }),
    years: "2017-2019",
    pages: 1,
    limit: 10,
    minVotes: 100,
    ...options,
  });
  return { report, calls };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Le snapshot livré vérifie stableId("work", strictIdentityKey(titre)) === id pour ses 41 914 œuvres. Quand le
// rapprochement par titre écartait un candidat parce que l'année ne correspondait pas — un remake, un homonyme —,
// le repli forgeait exactement l'identifiant qui venait d'être refusé : aucune œuvre n'était créée et le crédit
// partait sur le film écarté.
test("a title already known under another year does not recycle the existing work's identifier", async () => {
  const miserablesId = stableId("work", strictIdentityKey("Les Misérables"));
  const snapshot = baseSnapshot();
  snapshot.works.push(localWork(miserablesId, "Les Misérables", 1995));
  const paths = await workspace({ snapshot });
  const { report } = await runImport(paths, {
    years: "2019",
    limit: 1,
    fixtures: {
      "discover:2019:1": { page: 1, results: [{ id: 400_010, title: "Les Misérables", release_date: "2019-11-20", popularity: 22.5, vote_count: 910 }] },
      "credits:400010": { id: 400_010, cast: [{ id: 500_010, name: "Damien Bonnard", original_name: "Damien Bonnard", known_for_department: "Acting", order: 0, adult: false }] },
      "person:500010": personPayload({ id: 500_010, name: "Damien Bonnard", credits: [movieCredit(400_010, "Les Misérables", 2019)] }),
    },
  });
  assert.deepEqual(report.added.map((person) => person.name), ["Damien Bonnard"]);

  const after = await readJson(paths.snapshotPath);
  const bonnard = after.people.find((person) => person.name === "Damien Bonnard");
  // Le crédit ne doit pas pointer sur le film de 1995, et l'œuvre de 2019 doit exister pour de bon.
  assert.equal(bonnard.credits.includes(miserablesId), false);
  const credited = after.works.find((work) => work.id === bonnard.credits[0]);
  assert.equal(credited.title, "Les Misérables");
  assert.equal(credited.year, 2019);
  assert.equal(after.works.filter((work) => work.title === "Les Misérables").length, 2);
});

test("an import wave adds the artists the snapshot lacks, with their films, in both files", async () => {
  const paths = await workspace();
  const { report } = await runImport(paths);
  const [snapshot, overlay] = await Promise.all([readJson(paths.snapshotPath), readJson(paths.overlayPath)]);

  // The wave walks the window from the most recent year backwards: 2019 is emptied before 2017.
  assert.deepEqual(report.added.map((person) => person.name), ["Pio Marmaï", "Camille Chamoux", "Léa Bertrand", "Alban Ivanov"]);
  assert.equal(report.written, true);
  assert.equal(snapshot.people.length, 6);
  assert.equal(overlay.people.length, 6);

  const marmai = snapshot.people.find((person) => person.name === "Pio Marmaï");
  assert.equal(marmai.id, stableId("person", "pio marmai"));
  assert.equal(marmai.source, "tmdb-import");
  assert.deepEqual(marmai.roles, ["acting"]);
  assert.deepEqual(marmai.tags, ["fr"]);
  assert.equal(marmai.externalIds.tmdb, 500_002);
  assert.equal(marmai.externalIds.imdb, "nm2153663");
  // A spelling that folds onto the name and a transliteration into another script index no new key: the overlay keeps
  // them, the snapshot does not carry the weight.
  assert.deepEqual(marmai.aliases, []);
  assert.deepEqual(snapshot.people.find((person) => person.name === "Léa Bertrand").aliases, ["Bertrand, Léa", "Léa B. Bertrand"]);
  assert.equal(marmai.birthYear, 1979);
  // The film the snapshot already owned keeps its canonical identifier: the newcomer is chained to the artists already there.
  assert.equal(marmai.credits.includes("work_lesens"), true);
  assert.equal(marmai.credits.length, 2);
  const newWork = snapshot.works.find((work) => work.title === "Ce qui nous lie");
  assert.equal(marmai.credits.includes(newWork.id), true);
  assert.equal(newWork.year, 2017);
  assert.equal(newWork.type, "movie");
  // A television credit belongs to the overlay filmography, never to the cinema chain.
  assert.equal(snapshot.works.some((work) => work.title === "Une série française"), false);

  const remoteMarmai = overlay.people.find((person) => person.localPersonId === marmai.id);
  assert.equal(remoteMarmai.externalIds.tmdb, 500_002);
  assert.equal(remoteMarmai.profilePath, `${IMAGE_ROOT}/marmai7.jpg`);
  assert.equal(remoteMarmai.matchedBy, "tmdb-cast-import");
  assert.deepEqual(remoteMarmai.aliases, ["Pio Marmai", "Пио Мармай"]);
  assert.deepEqual(remoteMarmai.credits.slice().sort(), ["tmdb-movie:400001", "tmdb-movie:400003", "tmdb-tv:700001"].sort());
  assert.equal(overlay.works.some((work) => work.id === "tmdb-tv:700001"), true);
  assert.equal(overlay.stats.people, overlay.people.length);
  assert.equal(overlay.stats.works, overlay.works.length);
  assert.equal(overlay.stats.credits, overlay.people.reduce((sum, person) => sum + person.credits.length, 0));
  assert.equal(snapshot.quality.people, snapshot.people.length);
  assert.equal(snapshot.quality.works, snapshot.works.length);
  assert.equal(snapshot.snapshotId, SNAPSHOT_ID);
  assert.equal(overlay.baseSnapshotId, SNAPSHOT_ID);
  assert.equal(snapshot.sources.some((source) => source.id === "tmdb-cast-import"), true);
});

test("an artist the catalogue already knows is skipped, by TMDb identifier and by normalised name", async () => {
  const paths = await workspace();
  const { report, calls } = await runImport(paths);
  const snapshot = await readJson(paths.snapshotPath);

  assert.equal(report.skipped.knownById, 1);
  assert.equal(report.skipped.knownByName, 1);
  assert.equal(report.skipped.alreadyQueued, 1);
  assert.equal(report.skipped.withoutFilm, 1);
  // Billed inside the window but listed by TMDb as crew: reported rather than silently swallowed.
  assert.equal(report.skipped.notActing, 1);
  assert.equal(report.castSeen, 9);
  assert.equal(snapshot.people.filter((person) => normalizeText(person.name) === "vincent cassel").length, 1);
  assert.equal(snapshot.people.filter((person) => normalizeText(person.name) === "jean dujardin").length, 1);
  // Neither the known identifier nor the known name ever reached the expensive person endpoint.
  assert.equal(calls.includes("/3/person/1640"), false);
  assert.equal(calls.includes("/3/person/500001"), false);
  assert.equal(new Set(snapshot.people.map((person) => normalizeText(person.name))).size, snapshot.people.length);
});

test("a second wave with the same budget adds nothing and rewrites nothing", async () => {
  const paths = await workspace();
  await runImport(paths);
  const [firstSnapshot, firstOverlay] = await Promise.all([readFile(paths.snapshotPath, "utf8"), readFile(paths.overlayPath, "utf8")]);

  const { report, calls } = await runImport(paths);
  const [secondSnapshot, secondOverlay] = await Promise.all([readFile(paths.snapshotPath, "utf8"), readFile(paths.overlayPath, "utf8")]);

  assert.deepEqual(report.added, []);
  assert.equal(report.written, false);
  assert.equal(report.skipped.knownById, 5);
  assert.equal(report.skipped.knownByName, 1);
  assert.equal(secondSnapshot, firstSnapshot);
  assert.equal(secondOverlay, firstOverlay);
  // Only the cast member without a single film is looked at again: a negative result is never written into the catalogue.
  assert.deepEqual(calls.filter((path) => path.startsWith("/3/person/")), ["/3/person/500007"]);
});

test("the snapshot and the overlay stay the same set of identities", async () => {
  const paths = await workspace();
  await runImport(paths);
  const [snapshot, overlay] = await Promise.all([readJson(paths.snapshotPath), readJson(paths.overlayPath)]);

  assert.deepEqual(new Set(overlay.people.map((person) => person.localPersonId)), new Set(snapshot.people.map((person) => person.id)));
  assert.equal(new Set(overlay.people.map((person) => person.localPersonId)).size, overlay.people.length);
  assert.equal(new Set(overlay.people.map((person) => person.externalIds.tmdb)).size, overlay.people.length);
  assert.equal(overlay.failures.length, 0);
  assert.equal(new Set(overlay.works.map((work) => work.id)).size, overlay.works.length);
  const overlayWorkIds = new Set(overlay.works.map((work) => work.id));
  assert.equal(overlay.people.flatMap((person) => person.credits).every((creditId) => overlayWorkIds.has(creditId)), true);
  assert.equal(overlay.works.some((work) => work.externalIds?.tmdb !== undefined), false);
  const snapshotWorkIds = new Set(snapshot.works.map((work) => work.id));
  assert.equal(snapshot.people.flatMap((person) => person.credits).every((creditId) => snapshotWorkIds.has(creditId)), true);
  assert.equal(new Set(snapshot.works.map((work) => work.id)).size, snapshot.works.length);

  const remoteTitles = new Map(overlay.works.map((work) => [work.id, normalizeText(work.title)]));
  const localTitles = new Map(snapshot.works.map((work) => [work.id, normalizeText(work.title)]));
  for (const person of overlay.people.filter((entry) => entry.matchedBy === "tmdb-cast-import")) {
    const local = new Set(snapshot.people.find((entry) => entry.id === person.localPersonId).credits.map((workId) => localTitles.get(workId)));
    // The overlay test demands film evidence for every automatic identity: an import must satisfy it by construction.
    assert.equal(person.credits.some((workId) => local.has(remoteTitles.get(workId))), true, `${person.name} lacks film evidence`);
  }

  const portraitPath = join(paths.directory, "tmdb-portraits.json");
  await buildPortraitIndex({ inputPath: paths.overlayPath, outputPath: portraitPath });
  const portraits = await readJson(portraitPath);
  const expected = overlay.people.filter((person) => person.profilePath);
  assert.equal(Object.keys(portraits.people).length, expected.length);
  for (const person of expected) assert.equal(`${portraits.base}${portraits.people[person.localPersonId]}`, person.profilePath);
  // A profile path the portrait index could not republish verbatim is dropped rather than shipped broken.
  for (const path of Object.values(portraits.people)) assert.match(path, /^\/[A-Za-z0-9]+\.(jpg|png)$/);
  assert.equal(overlay.people.find((person) => person.name === "Alban Ivanov").profilePath, null);
});

test("identifiers are stable across runs and a budget is honoured then resumed", async () => {
  const first = await workspace();
  const second = await workspace();
  const { report: full } = await runImport(first);
  const { report: budgeted } = await runImport(second, { limit: 1 });
  assert.deepEqual(budgeted.added.map((person) => person.name), ["Pio Marmaï"]);
  assert.equal(budgeted.added[0].id, full.added[0].id);

  const { report: resumed } = await runImport(second, { limit: 1 });
  assert.deepEqual(resumed.added.map((person) => person.name), ["Camille Chamoux"]);
  assert.equal(resumed.added[0].id, full.added[1].id);

  const [left, right] = await Promise.all([readJson(first.snapshotPath), readJson(second.snapshotPath)]);
  assert.deepEqual(right.people.map((person) => person.id), left.people.slice(0, right.people.length).map((person) => person.id));
  const { report: third } = await runImport(second, { limit: 1 });
  const { report: fourth } = await runImport(second, { limit: 1 });
  const finished = await readJson(second.snapshotPath);
  assert.deepEqual([...third.added, ...fourth.added].map((person) => person.name), ["Léa Bertrand", "Alban Ivanov"]);
  assert.deepEqual(finished.people.map((person) => person.id), left.people.map((person) => person.id));
  assert.deepEqual(finished.works.map((work) => work.id), left.works.map((work) => work.id));
  for (const person of finished.people.filter((entry) => entry.source === "tmdb-import")) assert.match(person.id, /^person_[a-z0-9]{7}$/);
});

test("a rehearsal reports what it would add and writes nothing", async () => {
  const paths = await workspace();
  const [snapshotBefore, overlayBefore] = await Promise.all([readFile(paths.snapshotPath, "utf8"), readFile(paths.overlayPath, "utf8")]);
  const { report } = await runImport(paths, { dryRun: true });
  const [snapshotAfter, overlayAfter] = await Promise.all([readFile(paths.snapshotPath, "utf8"), readFile(paths.overlayPath, "utf8")]);

  assert.equal(report.dryRun, true);
  assert.equal(report.written, false);
  assert.equal(report.added.length, 4);
  assert.equal(report.newWorks, 3);
  assert.equal(snapshotAfter, snapshotBefore);
  assert.equal(overlayAfter, overlayBefore);
  assert.equal(existsSync(`${paths.snapshotPath}.tmp`), false);
  assert.equal(existsSync(`${paths.overlayPath}.tmp`), false);
});

test("a local identifier already taken is never overwritten", async () => {
  const snapshot = baseSnapshot();
  const overlay = baseOverlay();
  const stolen = stableId("person", "camille chamoux");
  snapshot.people.push(localPerson(stolen, "Homonyme Improbable", ["work_lahaine"]));
  overlay.people.push(overlayPerson(stolen, 999_999, "Homonyme Improbable", ["tmdb-movie:406"]));
  const paths = await workspace({ snapshot, overlay });

  const { report } = await runImport(paths);
  const written = await readJson(paths.snapshotPath);
  assert.equal(report.skipped.idCollision, 1);
  assert.equal(report.added.some((person) => person.name === "Camille Chamoux"), false);
  assert.equal(report.failures.some((failure) => failure.reason.includes(stolen)), true);
  assert.equal(written.people.find((person) => person.id === stolen).name, "Homonyme Improbable");
});

test("the discovery window is read defensively", () => {
  assert.deepEqual(parseYearRange("2005-2026"), { from: 2005, to: 2026 });
  assert.deepEqual(parseYearRange("2019"), { from: 2019, to: 2019 });
  assert.deepEqual(parseYearRange("2026-2005"), { from: 2005, to: 2026 });
  assert.deepEqual(parseYearRange("n’importe quoi", { defaultFrom: 2005, defaultTo: 2026 }), { from: 2005, to: 2026 });
  assert.deepEqual(nameKeys("Marmaï, Pio"), ["marmai pio", "pio marmai"]);
});

// Une erreur HTTP sur /discover ou /credits remontait à travers le générateur : la vague échouait en entier et les
// identités déjà acquises n'étaient jamais écrites, alors que chacune avait coûté un appel réseau.
test("a network failure mid-wave keeps what was already collected", async () => {
  const paths = await workspace();
  let calls = 0;
  const failing = async (url) => {
    const target = new URL(String(url));
    if (target.pathname === "/3/discover/movie") {
      calls += 1;
      // La première année répond, la suivante tombe.
      if (calls > 1) return { ok: false, status: 503, json: async () => ({ status_message: "service indisponible" }) };
    }
    return fixtureFetch()(url);
  };
  const report = await importTmdbCast({
    snapshotPath: paths.snapshotPath,
    overlayPath: paths.overlayPath,
    snapshotOutputPath: paths.snapshotPath,
    overlayOutputPath: paths.overlayPath,
    token: "fixture-token",
    fetchImpl: failing,
    years: "2017-2019",
    pages: 1,
    limit: 10,
    minVotes: 100,
  });

  // L'incident est consigné, et ce qui avait été trouvé avant la coupure est bien enregistré.
  assert.equal(report.failures.some((failure) => /Exploration interrompue/.test(failure.reason)), true);
  assert.equal(report.added.length > 0, true);
  assert.equal(report.written, true);
  const snapshot = await readJson(paths.snapshotPath);
  for (const added of report.added) {
    assert.equal(snapshot.people.some((person) => person.name === added.name), true, added.name);
  }
});
