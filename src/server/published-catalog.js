import { readFile } from "node:fs/promises";
import { WORK_KINDS, workKind } from "../game/work-kinds.js";

// Le catalogue publié est un fichier : il porte ce que la synchronisation y a mis le jour où elle l'a écrit. Les
// éditions antérieures aux natures d'œuvres ne savent donc pas dire qu'un crédit est un documentaire, et une
// fiche muette rouvrirait la porte à tout ce que le jeu vient de fermer. Quand TMDb est configuré, on va
// rechercher la fiche fraîche plutôt que de servir la muette ; sinon on sert ce qu'on a, et le socle joue avec
// l'inconnu comme avant. La re-synchronisation par lots rend cet aller-retour inutile, fiche après fiche.
function needsKinds(person) {
  return (person?.credits ?? []).some((work) => workKind(work) === WORK_KINDS.UNKNOWN);
}

export function createPublishedCatalog({ overlayUrl = new URL("../data/tmdb-overlay.json", import.meta.url), tmdb = null } = {}) {
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
    const published = {
      ...person,
      credits: (person.credits ?? []).map((workId) => worksById.get(workId)).filter(Boolean),
    };
    if (!tmdb?.configured || !person.externalIds?.tmdb || !needsKinds(published)) return published;
    try {
      // L'identité locale prime : c'est elle que la partie a en main, et le catalogue distant ne vient ici que
      // pour la filmographie. Renommer l'artiste au passage casserait la chaîne en cours.
      const fresh = await tmdb.getPerson(person.externalIds.tmdb);
      return { ...published, credits: fresh.credits ?? published.credits };
    } catch {
      // Un quota atteint ou un réseau coupé ne valent pas une fiche vide : la version publiée reste jouable.
      return published;
    }
  }

  async function stats() {
    const { overlay } = await load();
    return { ...overlay.stats, generatedAt: overlay.generatedAt, failures: overlay.failures?.length ?? 0 };
  }

  return { getPerson, stats };
}
