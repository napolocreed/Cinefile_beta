import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTmdbClient } from "../src/server/tmdb.js";
import { normalizeText } from "../src/game/identity.js";

const root = resolve(import.meta.dirname, "..");
const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=") || true];
}));
const limit = Math.max(1, Number(argumentsMap.get("limit") ?? 50));
const inputPath = resolve(root, String(argumentsMap.get("input") ?? "src/data/cinema-knowledge.json"));
const outputPath = resolve(root, String(argumentsMap.get("output") ?? "src/data/tmdb-overlay.local.json"));
const delayMs = Math.max(0, Number(argumentsMap.get("delay") ?? 260));
const tmdb = createTmdbClient();

if (!tmdb.configured) {
  console.error("Configure TMDB_API_TOKEN (recommandé) ou TMDB_API_KEY avant de lancer la synchronisation.");
  process.exitCode = 1;
} else {
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  const overlay = existsSync(outputPath)
    ? JSON.parse(await readFile(outputPath, "utf8"))
    : { version: 1, baseSnapshotId: snapshot.snapshotId, generatedAt: null, people: [], failures: [] };
  const completed = new Set(overlay.people.map((person) => normalizeText(person.name)));
  const queue = snapshot.people
    .filter((person) => !person.externalIds?.tmdb && !completed.has(normalizeText(person.name)))
    .sort((left, right) => Number(right.popularity ?? 0) - Number(left.popularity ?? 0))
    .slice(0, limit);

  for (const [index, localPerson] of queue.entries()) {
    try {
      const results = await tmdb.searchPeople(localPerson.name, { locale: "fr-FR", limit: 5 });
      const candidate = results.find((person) => normalizeText(person.name) === normalizeText(localPerson.name));
      if (!candidate) throw new Error("Aucune correspondance exacte; revue humaine requise.");
      const person = await tmdb.getPerson(candidate.externalIds.tmdb, { locale: "fr-FR" });
      overlay.people.push({ ...person, localPersonId: localPerson.id, matchedBy: "normalized-exact" });
      overlay.failures = overlay.failures.filter((failure) => failure.localPersonId !== localPerson.id);
      console.log(`[${index + 1}/${queue.length}] ${localPerson.name}: ${person.credits.length} crédits`);
    } catch (error) {
      overlay.failures.push({ localPersonId: localPerson.id, name: localPerson.name, reason: error.message, attemptedAt: new Date().toISOString() });
      console.warn(`[${index + 1}/${queue.length}] ${localPerson.name}: ${error.message}`);
    }
    overlay.generatedAt = new Date().toISOString();
    const temporaryPath = `${outputPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(overlay, null, 2)}\n`);
    await rename(temporaryPath, outputPath);
    if (index < queue.length - 1 && delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }

  console.log(`Synchronisation incrémentale terminée: ${overlay.people.length} personnes enrichies, ${overlay.failures.length} à revoir.`);
}
