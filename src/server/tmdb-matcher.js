import { normalizeText } from "../game/identity.js";

function localTitleSet(localPerson, worksById) {
  return new Set((localPerson.credits ?? [])
    .map((workId) => worksById.get(workId))
    .filter(Boolean)
    .flatMap((work) => [work.title, work.originalTitle, ...(work.aliases ?? [])])
    .map(normalizeText)
    .filter(Boolean));
}

function remoteTitleSet(person) {
  return new Set((person.credits ?? [])
    .flatMap((work) => [work.title, work.originalTitle, ...(work.aliases ?? [])])
    .map(normalizeText)
    .filter(Boolean));
}

function hasExactNameOrAlias(person, localName) {
  const expected = normalizeText(localName);
  return [person.name, ...(person.aliases ?? [])].some((name) => normalizeText(name) === expected);
}

export async function resolveTmdbCandidate({ localPerson, candidates, worksById, getPerson }) {
  if (!candidates.length) throw new Error("Aucun résultat TMDb; revue humaine requise.");
  const expectedName = normalizeText(localPerson.name);
  const localTitles = localTitleSet(localPerson, worksById);
  const pool = candidates.slice(0, 5);
  const scored = [];
  for (const candidate of pool) {
    const person = await getPerson(candidate.externalIds.tmdb);
    const titles = remoteTitleSet(person);
    const overlap = [...localTitles].filter((title) => titles.has(title)).length;
    scored.push({
      person,
      overlap,
      searchNameExact: normalizeText(candidate.name) === expectedName,
      aliasMatch: hasExactNameOrAlias(person, localPerson.name),
    });
  }
  scored.sort((left, right) => right.overlap - left.overlap || Number(right.aliasMatch) - Number(left.aliasMatch) || Number(right.person.popularity ?? 0) - Number(left.person.popularity ?? 0));

  const best = scored[0];
  const runnerUp = scored[1];
  const uniqueBest = !runnerUp || best.overlap > runnerUp.overlap;
  if (!uniqueBest) throw new Error("Plusieurs identités sans recouvrement filmographique décisif; revue humaine requise.");
  if (best.searchNameExact && best.overlap >= 1) return { person: best.person, matchedBy: "normalized-exact-credit-overlap" };
  if (best.aliasMatch && best.overlap >= 1) return { person: best.person, matchedBy: "tmdb-alias-credit-overlap" };
  if (best.overlap >= 2) return { person: best.person, matchedBy: "tmdb-search-credit-overlap" };
  throw new Error("Aucune identité avec un recouvrement filmographique suffisant; revue humaine requise.");
}
