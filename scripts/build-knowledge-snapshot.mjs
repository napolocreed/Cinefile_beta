import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeText, parseYear, stableId, strictIdentityKey } from "../src/game/identity.js";

const root = resolve(import.meta.dirname, "..");
const legacyPath = resolve(root, "src/data/cinema-database.json");
const synonymPath = resolve(root, "src/data/cinema-synonyms.json");
const snapshotPath = resolve(root, "src/data/cinema-knowledge.json");
const mergeLogPath = resolve(root, "src/data/cinema-merge-log.json");
const qualityPath = resolve(root, "src/data/cinema-quality.json");

const [legacy, synonyms] = await Promise.all([
  readFile(legacyPath, "utf8").then(JSON.parse),
  readFile(synonymPath, "utf8").then(JSON.parse),
]);

const workAliasToCanonical = new Map();
const curatedWorks = new Map();
for (const entry of synonyms.works ?? []) {
  const canonicalKey = strictIdentityKey(entry.canonical);
  const values = [entry.canonical, ...(entry.aliases ?? [])];
  curatedWorks.set(canonicalKey, { canonical: entry.canonical, aliases: values });
  for (const value of values) workAliasToCanonical.set(strictIdentityKey(value), canonicalKey);
}

const personSynonyms = new Map();
for (const entry of synonyms.people ?? []) {
  for (const value of [entry.canonical, ...(entry.aliases ?? [])]) personSynonyms.set(normalizeText(value), entry);
}
const filmOccurrences = new Map();
for (const actor of legacy.actors ?? []) {
  for (const title of actor.films ?? []) filmOccurrences.set(title, (filmOccurrences.get(title) ?? 0) + 1);
}

const rawTitles = new Set([...(legacy.films ?? [])]);
for (const actor of legacy.actors ?? []) for (const title of actor.films ?? []) rawTitles.add(title);
for (const entry of synonyms.works ?? []) {
  rawTitles.add(entry.canonical);
  for (const alias of entry.aliases ?? []) rawTitles.add(alias);
}

const workGroups = new Map();
for (const title of rawTitles) {
  const strictKey = strictIdentityKey(title);
  if (!strictKey) continue;
  const groupKey = workAliasToCanonical.get(strictKey) ?? strictKey;
  const group = workGroups.get(groupKey) ?? { titles: new Set(), curated: curatedWorks.get(groupKey) ?? null };
  group.titles.add(title);
  workGroups.set(groupKey, group);
}

function preferredTitle(group) {
  if (group.curated) return group.curated.canonical;
  return [...group.titles].sort((left, right) => {
    const occurrenceDifference = (filmOccurrences.get(right) ?? 0) - (filmOccurrences.get(left) ?? 0);
    return occurrenceDifference || left.length - right.length || left.localeCompare(right, "fr");
  })[0];
}

const works = [];
const workIdBySourceTitle = new Map();
const mergeLog = [];
for (const [groupKey, group] of [...workGroups].sort(([left], [right]) => left.localeCompare(right, "fr"))) {
  const title = preferredTitle(group);
  const sourceTitles = [...group.titles].sort((left, right) => left.localeCompare(right, "fr"));
  const aliases = sourceTitles.filter((candidate) => candidate !== title);
  const id = stableId("work", groupKey);
  const work = {
    id,
    title,
    originalTitle: null,
    aliases,
    year: parseYear(title),
    type: "movie",
    externalIds: {},
    source: "lovable-recovery",
  };
  works.push(work);
  for (const sourceTitle of sourceTitles) workIdBySourceTitle.set(strictIdentityKey(sourceTitle), id);
  if (sourceTitles.length > 1) {
    mergeLog.push({
      entity: "work",
      canonicalId: id,
      kept: title,
      merged: aliases,
      strategy: group.curated ? "curated-synonym" : "strict-title",
      confidence: group.curated ? 1 : 0.98,
      reversible: true,
    });
  }
}

const peopleGroups = new Map();
for (const rawPerson of legacy.actors ?? []) {
  const synonym = personSynonyms.get(normalizeText(rawPerson.name));
  const key = normalizeText(synonym?.canonical ?? rawPerson.name);
  if (!key) continue;
  const previous = peopleGroups.get(key);
  if (!previous) peopleGroups.set(key, { ...rawPerson, names: new Set([rawPerson.name]), films: new Set(rawPerson.films ?? []), tags: new Set(rawPerson.tags ?? []) });
  else {
    previous.names.add(rawPerson.name);
    for (const title of rawPerson.films ?? []) previous.films.add(title);
    for (const tag of rawPerson.tags ?? []) previous.tags.add(tag);
  }
}

const people = [];
for (const [key, rawPerson] of peopleGroups) {
  const synonym = personSynonyms.get(key);
  const name = synonym?.canonical ?? rawPerson.name;
  const sourceNames = [...rawPerson.names];
  const aliases = [...new Set([...(synonym?.aliases ?? []), ...sourceNames])]
    .filter((alias) => normalizeText(alias) !== normalizeText(name) || alias !== name);
  const credits = [...rawPerson.films]
    .map((title) => workIdBySourceTitle.get(strictIdentityKey(title)))
    .filter(Boolean);
  people.push({
    id: stableId("person", key),
    name,
    aliases,
    roles: ["acting"],
    tags: [...rawPerson.tags],
    birthYear: null,
    deathYear: null,
    profilePath: null,
    popularity: credits.length,
    externalIds: {},
    credits: [...new Set(credits)],
    source: "lovable-recovery",
  });
  if (sourceNames.length > 1) {
    mergeLog.push({
      entity: "person",
      canonicalId: stableId("person", key),
      kept: name,
      merged: sourceNames.filter((sourceName) => sourceName !== name),
      strategy: "curated-person-synonym",
      confidence: 1,
      reversible: true,
    });
  }
}

const fuzzyTitleGroups = new Map();
for (const work of works) {
  const key = normalizeText(work.title);
  const group = fuzzyTitleGroups.get(key) ?? [];
  group.push({ id: work.id, title: work.title, year: work.year });
  fuzzyTitleGroups.set(key, group);
}
const reviewCandidates = [...fuzzyTitleGroups.values()].filter((group) => group.length > 1);
const orphanWorks = new Set(works.map((work) => work.id));
for (const person of people) for (const workId of person.credits) orphanWorks.delete(workId);
const snapshotId = stableId("snapshot", `${people.length}:${works.length}:${mergeLog.length}:${synonyms.version}`);
const generatedAt = new Date().toISOString();
const quality = {
  version: 1,
  snapshotId,
  generatedAt,
  people: people.length,
  works: works.length,
  credits: people.reduce((sum, person) => sum + person.credits.length, 0),
  aliases: people.reduce((sum, person) => sum + person.aliases.length, 0) + works.reduce((sum, work) => sum + work.aliases.length, 0),
  automaticMerges: mergeLog.filter((entry) => entry.strategy === "strict-title").length,
  curatedMerges: mergeLog.filter((entry) => entry.strategy === "curated-synonym" || entry.strategy === "curated-person-synonym").length,
  reviewCandidates: reviewCandidates.length,
  orphanWorks: orphanWorks.size,
  peopleWithoutCredits: people.filter((person) => !person.credits.length).length,
  unresolvedTitleCandidates: reviewCandidates,
};
const snapshot = {
  version: 2,
  snapshotId,
  generatedAt,
  locale: "fr-FR",
  sources: [{ id: "lovable-recovery", importedAt: generatedAt }],
  people,
  works,
  mergeLog,
  quality: { ...quality, unresolvedTitleCandidates: undefined },
};

await Promise.all([
  writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`),
  writeFile(mergeLogPath, `${JSON.stringify({ version: 1, snapshotId, generatedAt, entries: mergeLog }, null, 2)}\n`),
  writeFile(qualityPath, `${JSON.stringify(quality, null, 2)}\n`),
]);

console.log(`Snapshot ${snapshotId}: ${people.length} personnes, ${works.length} œuvres, ${mergeLog.length} fusions traçables.`);
