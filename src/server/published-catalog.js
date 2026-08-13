import { readFile } from "node:fs/promises";

export function createPublishedCatalog({ overlayUrl = new URL("../data/tmdb-overlay.json", import.meta.url) } = {}) {
  let cataloguePromise = null;

  async function load() {
    if (!cataloguePromise) {
      cataloguePromise = readFile(overlayUrl, "utf8").then((raw) => {
        const overlay = JSON.parse(raw);
        const worksById = new Map((overlay.works ?? []).map((work) => [work.id, work]));
        const peopleByLocalId = new Map((overlay.people ?? []).map((person) => [person.localPersonId, person]));
        return { overlay, worksById, peopleByLocalId };
      }).catch((error) => {
        cataloguePromise = null;
        throw error;
      });
    }
    return cataloguePromise;
  }

  async function getPerson(localPersonId) {
    const { peopleByLocalId, worksById } = await load();
    const person = peopleByLocalId.get(localPersonId);
    if (!person) return null;
    return {
      ...person,
      credits: (person.credits ?? []).map((workId) => worksById.get(workId)).filter(Boolean),
    };
  }

  async function stats() {
    const { overlay } = await load();
    return { ...overlay.stats, generatedAt: overlay.generatedAt, failures: overlay.failures?.length ?? 0 };
  }

  return { getPerson, stats };
}
