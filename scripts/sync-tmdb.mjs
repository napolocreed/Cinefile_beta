import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTmdbClient } from "../src/server/tmdb.js";
import { resolveTmdbCandidate } from "../src/server/tmdb-matcher.js";
import { normalizeText } from "../src/game/identity.js";

const root = resolve(import.meta.dirname, "..");
const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=") || true];
}));
const limit = Math.max(1, Number(argumentsMap.get("limit") ?? 50));
const inputPath = resolve(root, String(argumentsMap.get("input") ?? "src/data/cinema-knowledge.json"));
const outputPath = resolve(root, String(argumentsMap.get("output") ?? "src/data/tmdb-overlay.local.json"));
const overridesPath = resolve(root, String(argumentsMap.get("overrides") ?? "src/data/tmdb-person-overrides.json"));
const delayMs = Math.max(0, Number(argumentsMap.get("delay") ?? 260));
const refreshAfterDays = Math.max(1, Number(argumentsMap.get("refresh-days") ?? 60));
const onlyFailures = argumentsMap.has("only-failures");
// Le catalogue publié avant les natures d'œuvres ne sait pas dire qu'un crédit est un documentaire ou une
// émission, et le jeu doit alors le laisser passer faute de mieux. Ce drapeau ne remet en file que les fiches
// encore muettes : la campagne se relance autant de fois qu'il faut, et s'arrête d'elle-même quand il n'en reste
// aucune — sans jamais redemander à TMDb ce qu'on a déjà.
const onlyMissingKinds = argumentsMap.has("only-missing-kinds");
const acceptExactZeroOverlap = argumentsMap.has("accept-exact-zero-overlap");
const tmdb = createTmdbClient();

const DAY_MS = 24 * 60 * 60 * 1000;

function ageInDays(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? (Date.now() - time) / DAY_MS : Number.POSITIVE_INFINITY;
}

function existingCreditOverlap(localPerson, remotePerson, localWorksById, remoteWorksById) {
  const localTitles = new Set((localPerson?.credits ?? [])
    .flatMap((workId) => {
      const work = localWorksById.get(workId);
      return work ? [work.title, work.originalTitle, ...(work.aliases ?? [])] : [];
    })
    .map(normalizeText)
    .filter(Boolean));
  const remoteTitles = new Set((remotePerson?.credits ?? [])
    .flatMap((workId) => {
      const work = remoteWorksById.get(workId);
      return work ? [work.title, work.originalTitle, ...(work.aliases ?? [])] : [];
    })
    .map(normalizeText)
    .filter(Boolean));
  return [...localTitles].filter((title) => remoteTitles.has(title)).length;
}

async function saveOverlay(overlay) {
  const workById = new Map((overlay.works ?? []).map((work) => [work.id, work]));
  const referencedWorkIds = new Set();
  for (const person of overlay.people) {
    const creditIds = [];
    for (const rawWork of person.credits ?? []) {
      if (typeof rawWork === "string") {
        if (workById.has(rawWork)) {
          creditIds.push(rawWork);
          referencedWorkIds.add(rawWork);
        }
        continue;
      }
      const work = { ...rawWork, externalIds: { ...(rawWork.externalIds ?? {}) } };
      if (work.externalIds.tmdb) {
        const { tmdb: legacyTmdbId, ...externalIds } = work.externalIds;
        externalIds[work.type === "tv" ? "tmdbTv" : "tmdbMovie"] = legacyTmdbId;
        work.externalIds = externalIds;
      }
      const previous = workById.get(work.id);
      workById.set(work.id, previous ? {
        ...previous,
        ...work,
        aliases: [...new Set([...(previous.aliases ?? []), ...(work.aliases ?? [])])],
        roles: [...new Set([...(previous.roles ?? []), ...(work.roles ?? [])])],
        externalIds: { ...previous.externalIds, ...work.externalIds },
      } : work);
      creditIds.push(work.id);
      referencedWorkIds.add(work.id);
    }
    person.credits = [...new Set(creditIds)];
  }
  overlay.version = 2;
  overlay.works = [...workById.values()].filter((work) => referencedWorkIds.has(work.id)).sort((left, right) => left.id.localeCompare(right.id));
  overlay.generatedAt = new Date().toISOString();
  overlay.refreshAfterDays = refreshAfterDays;
  overlay.stats = {
    people: overlay.people.length,
    works: overlay.works.length,
    credits: overlay.people.reduce((sum, person) => sum + (person.credits?.length ?? 0), 0),
  };
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(overlay)}\n`);
  await rename(temporaryPath, outputPath);
}

if (!tmdb.configured) {
  console.error("Configure TMDB_API_TOKEN (recommandé) ou TMDB_API_KEY avant de lancer la synchronisation.");
  process.exitCode = 1;
} else {
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  const overrides = existsSync(overridesPath)
    ? JSON.parse(await readFile(overridesPath, "utf8"))
    : { version: 1, matches: [] };
  const overrideByLocalId = new Map((overrides.matches ?? []).map((entry) => [entry.localPersonId, entry]));
  const overlay = existsSync(outputPath)
    ? JSON.parse(await readFile(outputPath, "utf8"))
    : { version: 1, baseSnapshotId: snapshot.snapshotId, generatedAt: null, people: [], failures: [] };
  overlay.people ??= [];
  overlay.failures ??= [];
  overlay.baseSnapshotId = snapshot.snapshotId;
  const worksById = new Map((snapshot.works ?? []).map((work) => [work.id, work]));
  const peopleById = new Map((snapshot.people ?? []).map((person) => [person.id, person]));
  const overlayWorksById = new Map((overlay.works ?? []).map((work) => [work.id, work]));
  const enrichedByLocalId = new Map(overlay.people.map((person) => [person.localPersonId, person]));
  const failureByLocalId = new Map(overlay.failures.map((failure) => [failure.localPersonId, failure]));
  for (const person of [...overlay.people]) {
    const localPerson = peopleById.get(person.localPersonId);
    if (!localPerson) {
      overlay.people = overlay.people.filter((entry) => entry.localPersonId !== person.localPersonId);
      enrichedByLocalId.delete(person.localPersonId);
      failureByLocalId.delete(person.localPersonId);
      console.warn(`[audit] ${person.name}: ancienne identité locale retirée après fusion canonique.`);
      continue;
    }
    const manualOverride = overrideByLocalId.get(person.localPersonId);
    if (manualOverride && String(person.externalIds?.tmdb) === String(manualOverride.tmdbId)) continue;
    const overlap = existingCreditOverlap(localPerson, person, worksById, overlayWorksById);
    if (overlap > 0) {
      if (person.matchedBy === "normalized-exact") person.matchedBy = "normalized-exact-credit-overlap-audited";
      continue;
    }
    overlay.people = overlay.people.filter((entry) => entry.localPersonId !== person.localPersonId);
    enrichedByLocalId.delete(person.localPersonId);
    failureByLocalId.set(person.localPersonId, {
      localPersonId: person.localPersonId,
      name: localPerson.name,
      reason: "Correspondance précédente rejetée: aucun crédit commun.",
      attemptedAt: new Date().toISOString(),
    });
    console.warn(`[audit] ${localPerson.name}: correspondance TMDb sans crédit commun retirée.`);
  }
  overlay.failures = [...failureByLocalId.values()];
  const missesKinds = (person) => (person?.credits ?? []).some((credit) => {
    const work = typeof credit === "string" ? overlayWorksById.get(credit) : credit;
    return work && !work.kind;
  });
  const queue = snapshot.people
    .filter((person) => !person.externalIds?.tmdb)
    .filter((person) => !onlyFailures || failureByLocalId.has(person.id))
    .filter((person) => {
      const enriched = enrichedByLocalId.get(person.id);
      if (onlyMissingKinds) return !enriched || missesKinds(enriched);
      return !enriched || ageInDays(enriched.syncedAt) >= refreshAfterDays;
    })
    .sort((left, right) => {
      const leftEnriched = enrichedByLocalId.get(left.id);
      const rightEnriched = enrichedByLocalId.get(right.id);
      if (Boolean(leftEnriched) !== Boolean(rightEnriched)) return leftEnriched ? 1 : -1;
      const leftFailed = failureByLocalId.has(left.id);
      const rightFailed = failureByLocalId.has(right.id);
      if (leftFailed !== rightFailed) return leftFailed ? 1 : -1;
      if (leftEnriched && rightEnriched) return Date.parse(leftEnriched.syncedAt ?? 0) - Date.parse(rightEnriched.syncedAt ?? 0);
      return Number(right.popularity ?? 0) - Number(left.popularity ?? 0);
    })
    .slice(0, limit);

  for (const [index, localPerson] of queue.entries()) {
    try {
      const manualOverride = overrideByLocalId.get(localPerson.id);
      let resolved;
      if (manualOverride) {
        resolved = {
          person: await tmdb.getPerson(manualOverride.tmdbId, { locale: "fr-FR" }),
          matchedBy: "manual-tmdb-id-review",
        };
      } else {
        const results = await tmdb.searchPeople(localPerson.name, { locale: "fr-FR", limit: 5, includeAdult: true });
        resolved = await resolveTmdbCandidate({
          localPerson,
          candidates: results,
          worksById,
          getPerson: (personId) => tmdb.getPerson(personId, { locale: "fr-FR" }),
        }).catch(async (error) => {
          if (!acceptExactZeroOverlap) throw error;
          const exactCandidates = results.filter((candidate) => normalizeText(candidate.name) === normalizeText(localPerson.name));
          if (exactCandidates.length !== 1) throw error;
          return {
            person: await tmdb.getPerson(exactCandidates[0].externalIds.tmdb, { locale: "fr-FR" }),
            matchedBy: "manual-exact-review",
          };
        });
      }
      const person = resolved.person;
      const enrichedPerson = { ...person, localPersonId: localPerson.id, matchedBy: resolved.matchedBy, syncedAt: new Date().toISOString() };
      const previousIndex = overlay.people.findIndex((entry) => entry.localPersonId === localPerson.id);
      if (previousIndex >= 0) overlay.people[previousIndex] = enrichedPerson;
      else overlay.people.push(enrichedPerson);
      failureByLocalId.delete(localPerson.id);
      overlay.failures = [...failureByLocalId.values()];
      console.log(`[${index + 1}/${queue.length}] ${localPerson.name}: ${person.credits.length} crédits`);
    } catch (error) {
      failureByLocalId.set(localPerson.id, { localPersonId: localPerson.id, name: localPerson.name, reason: error.message, attemptedAt: new Date().toISOString() });
      overlay.failures = [...failureByLocalId.values()];
      console.warn(`[${index + 1}/${queue.length}] ${localPerson.name}: ${error.message}`);
    }
    await saveOverlay(overlay);
    if (index < queue.length - 1 && delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }

  if (!queue.length) await saveOverlay(overlay);
  const unnamed = overlay.works.filter((work) => !work.kind).length;
  console.log(`Synchronisation incrémentale terminée: ${overlay.people.length} personnes enrichies, ${overlay.failures.length} à revoir, ${unnamed} œuvres encore sans nature.`);
}
