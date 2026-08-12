import { nameKeys, normalizeText, scoreTextMatch, stableId, strictIdentityKey } from "./identity.js";

export { normalizeText } from "./identity.js";

const unique = (values) => [...new Set((values ?? []).filter((value) => value !== null && value !== undefined && value !== ""))];
const externalKey = (source, id) => source && id !== null && id !== undefined && id !== "" ? `${source}:${id}` : null;

function addToMultiMap(map, key, value) {
  if (!key) return;
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function mergeExternalIds(previous = {}, incoming = {}) {
  return { ...previous, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== "")) };
}

export function createDatabase(data = {}, options = {}) {
  const people = [];
  const works = [];
  const peopleById = new Map();
  const worksById = new Map();
  const personIdsByNameKey = new Map();
  const workIdsByTitleKey = new Map();
  const personIdByExternalKey = new Map();
  const workIdByExternalKey = new Map();
  const sourcePriority = new Map([["manual", 5], ["tmdb", 4], ["snapshot", 3], ["lovable-recovery", 2], ["unknown", 1]]);
  const peopleSynonyms = new Map();
  const workSynonyms = new Map();

  for (const entry of options.synonyms?.people ?? data.synonyms?.people ?? []) {
    for (const value of [entry.canonical, ...(entry.aliases ?? [])]) peopleSynonyms.set(normalizeText(value), entry);
  }
  for (const entry of options.synonyms?.works ?? data.synonyms?.works ?? []) {
    for (const value of [entry.canonical, ...(entry.aliases ?? [])]) workSynonyms.set(strictIdentityKey(value), entry);
  }

  function indexWork(work) {
    for (const title of [work.title, work.originalTitle, ...(work.aliases ?? [])]) {
      addToMultiMap(workIdsByTitleKey, strictIdentityKey(title), work.id);
      addToMultiMap(workIdsByTitleKey, normalizeText(title), work.id);
    }
    for (const [source, id] of Object.entries(work.externalIds ?? {})) {
      const key = externalKey(source, id);
      if (key) workIdByExternalKey.set(key, work.id);
    }
  }

  function workCandidate(raw) {
    if (raw.id && worksById.has(raw.id)) return worksById.get(raw.id);
    for (const [source, id] of Object.entries(raw.externalIds ?? {})) {
      const candidateId = workIdByExternalKey.get(externalKey(source, id));
      if (candidateId) return worksById.get(candidateId);
    }
    const title = raw.title ?? raw.name;
    const synonym = workSynonyms.get(strictIdentityKey(title));
    const keys = unique([strictIdentityKey(title), normalizeText(title), synonym && strictIdentityKey(synonym.canonical)]);
    for (const key of keys) {
      for (const candidateId of workIdsByTitleKey.get(key) ?? []) {
        const candidate = worksById.get(candidateId);
        if (!candidate) continue;
        if (!raw.year || !candidate.year || Number(raw.year) === Number(candidate.year)) return candidate;
      }
    }
    return null;
  }

  function upsertWork(rawWork, { source = rawWork?.source ?? "unknown" } = {}) {
    if (typeof rawWork === "string") rawWork = { title: rawWork };
    const rawTitle = String(rawWork?.title ?? rawWork?.name ?? "").trim();
    if (!rawTitle) return null;
    const synonym = workSynonyms.get(strictIdentityKey(rawTitle));
    const title = synonym?.canonical ?? rawTitle;
    const incomingAliases = unique([
      ...(rawWork.aliases ?? []),
      rawWork.originalTitle && rawWork.originalTitle !== title ? rawWork.originalTitle : null,
      rawTitle !== title ? rawTitle : null,
      ...(synonym?.aliases ?? []),
    ]).filter((alias) => alias !== title);
    const candidate = workCandidate({ ...rawWork, title });
    if (candidate) {
      const currentPriority = sourcePriority.get(candidate.source) ?? 0;
      const incomingPriority = sourcePriority.get(source) ?? 0;
      if (incomingPriority > currentPriority && title) candidate.title = title;
      candidate.aliases = unique([...candidate.aliases, ...incomingAliases]).filter((alias) => alias !== candidate.title);
      candidate.originalTitle ||= rawWork.originalTitle ?? null;
      candidate.year ||= rawWork.year ? Number(rawWork.year) : null;
      candidate.type ||= rawWork.type ?? "movie";
      candidate.externalIds = mergeExternalIds(candidate.externalIds, rawWork.externalIds);
      candidate.source = incomingPriority > currentPriority ? source : candidate.source;
      indexWork(candidate);
      return candidate;
    }
    const id = rawWork.id || stableId("work", `${strictIdentityKey(title)}:${rawWork.year ?? ""}`);
    const work = {
      id,
      title,
      originalTitle: rawWork.originalTitle ?? null,
      aliases: incomingAliases,
      year: rawWork.year ? Number(rawWork.year) : null,
      type: rawWork.type ?? "movie",
      externalIds: mergeExternalIds({}, rawWork.externalIds),
      source,
    };
    works.push(work);
    worksById.set(id, work);
    indexWork(work);
    return work;
  }

  function indexPerson(person) {
    for (const value of [person.name, ...(person.aliases ?? [])]) {
      for (const key of nameKeys(value)) addToMultiMap(personIdsByNameKey, key, person.id);
    }
    for (const [source, id] of Object.entries(person.externalIds ?? {})) {
      const key = externalKey(source, id);
      if (key) personIdByExternalKey.set(key, person.id);
    }
  }

  function personCandidate(raw) {
    if (raw.id && peopleById.has(raw.id)) return peopleById.get(raw.id);
    for (const [source, id] of Object.entries(raw.externalIds ?? {})) {
      const candidateId = personIdByExternalKey.get(externalKey(source, id));
      if (candidateId) return peopleById.get(candidateId);
    }
    const ids = personIdsByNameKey.get(normalizeText(raw.name)) ?? new Set();
    for (const id of ids) {
      const candidate = peopleById.get(id);
      const conflicts = Object.entries(raw.externalIds ?? {}).some(([source, externalId]) => {
        const previousId = candidate.externalIds?.[source];
        return previousId && String(previousId) !== String(externalId);
      });
      if (!conflicts && (!raw.birthYear || !candidate.birthYear || Number(raw.birthYear) === Number(candidate.birthYear))) return candidate;
    }
    return null;
  }

  function resolveCredit(rawCredit, source) {
    if (typeof rawCredit === "string") {
      if (worksById.has(rawCredit)) return worksById.get(rawCredit);
      return upsertWork({ title: rawCredit }, { source });
    }
    if (rawCredit?.workId && worksById.has(rawCredit.workId)) return worksById.get(rawCredit.workId);
    return upsertWork(rawCredit, { source: rawCredit?.source ?? source });
  }

  function refreshPerson(person) {
    person.credits = unique(person.credits).filter((workId) => worksById.has(workId));
    person.films = person.credits.map((workId) => worksById.get(workId)?.title).filter(Boolean);
    person.creditCount = person.credits.length;
    return person;
  }

  function upsertPerson(rawPerson, { source = rawPerson?.source ?? "unknown" } = {}) {
    const rawName = String(rawPerson?.name ?? "").trim();
    if (!rawName) return null;
    const synonym = peopleSynonyms.get(normalizeText(rawName));
    const name = synonym?.canonical ?? rawName;
    const aliases = unique([
      ...(rawPerson.aliases ?? []),
      rawName !== name ? rawName : null,
      ...(synonym?.aliases ?? []),
    ]).filter((alias) => alias !== name);
    const externalIds = mergeExternalIds({}, rawPerson.externalIds);
    const candidate = personCandidate({ ...rawPerson, name, externalIds });
    const credits = unique([...(rawPerson.credits ?? []), ...(rawPerson.films ?? [])])
      .map((credit) => resolveCredit(credit, source)?.id)
      .filter(Boolean);
    if (candidate) {
      const currentPriority = sourcePriority.get(candidate.source) ?? 0;
      const incomingPriority = sourcePriority.get(source) ?? 0;
      if (incomingPriority > currentPriority && name) candidate.name = name;
      candidate.aliases = unique([...candidate.aliases, ...aliases]).filter((alias) => alias !== candidate.name);
      candidate.roles = unique([...candidate.roles, ...(rawPerson.roles ?? [rawPerson.knownForDepartment?.toLowerCase()].filter(Boolean))]);
      candidate.tags = unique([...candidate.tags, ...(rawPerson.tags ?? [])]);
      candidate.credits = unique([...candidate.credits, ...credits]);
      candidate.externalIds = mergeExternalIds(candidate.externalIds, externalIds);
      candidate.birthYear ||= rawPerson.birthYear ? Number(rawPerson.birthYear) : null;
      candidate.deathYear ||= rawPerson.deathYear ? Number(rawPerson.deathYear) : null;
      candidate.profilePath ||= rawPerson.profilePath ?? null;
      candidate.popularity = Math.max(Number(candidate.popularity ?? 0), Number(rawPerson.popularity ?? 0));
      candidate.source = incomingPriority > currentPriority ? source : candidate.source;
      indexPerson(candidate);
      return refreshPerson(candidate);
    }
    const id = rawPerson.id || stableId("person", `${normalizeText(name)}:${rawPerson.birthYear ?? ""}`);
    const person = {
      id,
      name,
      aliases,
      roles: unique(rawPerson.roles ?? [rawPerson.knownForDepartment?.toLowerCase() ?? "acting"]),
      tags: unique(rawPerson.tags ?? []),
      credits,
      films: [],
      creditCount: 0,
      birthYear: rawPerson.birthYear ? Number(rawPerson.birthYear) : null,
      deathYear: rawPerson.deathYear ? Number(rawPerson.deathYear) : null,
      profilePath: rawPerson.profilePath ?? null,
      popularity: Number(rawPerson.popularity ?? credits.length),
      externalIds,
      source,
    };
    people.push(person);
    peopleById.set(id, person);
    indexPerson(person);
    return refreshPerson(person);
  }

  if (Array.isArray(data.works)) for (const work of data.works) upsertWork(work, { source: work.source ?? "snapshot" });
  else for (const title of data.films ?? []) upsertWork({ title }, { source: "lovable-recovery" });

  if (Array.isArray(data.people)) {
    for (const person of data.people) upsertPerson(person, { source: person.source ?? "snapshot" });
  } else {
    for (const actor of data.actors ?? []) upsertPerson({ ...actor, roles: ["acting"] }, { source: "lovable-recovery" });
  }

  function isInTheme(person, themeId = "classic") {
    return themeId !== "fr" || person.tags.includes("fr");
  }

  function findPeople(value, themeId = "classic") {
    if (value && typeof value === "object" && value.id) {
      const person = peopleById.get(value.id);
      return person && isInTheme(person, themeId) ? [person] : [];
    }
    if (peopleById.has(value)) {
      const person = peopleById.get(value);
      return isInTheme(person, themeId) ? [person] : [];
    }
    const ids = personIdsByNameKey.get(normalizeText(value)) ?? new Set();
    return [...ids].map((id) => peopleById.get(id)).filter((person) => person && isInTheme(person, themeId));
  }

  function findActor(value, themeId = "classic") {
    const matches = findPeople(value, themeId);
    if (matches.length < 2) return matches[0] ?? null;
    const strict = strictIdentityKey(typeof value === "object" ? value.name : value);
    return matches.find((person) => strictIdentityKey(person.name) === strict) ?? matches[0];
  }

  function sharedWorks(left, right, themeId = "classic") {
    const leftPerson = findActor(left, themeId);
    const rightPerson = findActor(right, themeId);
    if (!leftPerson || !rightPerson) return [];
    const rightCredits = new Set(rightPerson.credits);
    return leftPerson.credits.filter((workId) => rightCredits.has(workId)).map((workId) => worksById.get(workId)).filter((work) => work?.type === "movie");
  }

  function searchPeople(query, { themeId = "classic", excluded = [], limit = 8, roles = null } = {}) {
    const excludedKeys = new Set(excluded.flatMap((value) => {
      const person = findActor(value, "classic");
      return person ? [person.id, normalizeText(person.name)] : [normalizeText(value)];
    }));
    const roleSet = roles ? new Set(roles.map((role) => role.toLowerCase())) : null;
    return people
      .filter((person) => isInTheme(person, themeId))
      .filter((person) => !excludedKeys.has(person.id) && !excludedKeys.has(normalizeText(person.name)))
      .filter((person) => !roleSet || person.roles.some((role) => roleSet.has(role.toLowerCase())))
      .map((person) => ({ person, score: Math.max(scoreTextMatch(query, person.name), ...person.aliases.map((alias) => scoreTextMatch(query, alias))) }))
      .filter(({ score }) => score >= 0.7)
      .sort((left, right) => right.score - left.score || right.person.popularity - left.person.popularity || right.person.creditCount - left.person.creditCount || left.person.name.localeCompare(right.person.name, "fr"))
      .slice(0, limit)
      .map(({ person, score }) => ({ ...person, matchScore: score, origin: person.source === "tmdb" ? "remote-cache" : "local" }));
  }

  function matchMentions(transcript, { themeId = "classic", excluded = [], limit = 5 } = {}) {
    const normalizedTranscript = ` ${normalizeText(transcript)} `;
    const excludedKeys = new Set(excluded.map(normalizeText));
    const exactMentions = [];
    for (const person of people) {
      if (!isInTheme(person, themeId) || excludedKeys.has(normalizeText(person.name))) continue;
      let bestAlias = null;
      for (const alias of [person.name, ...person.aliases]) {
        const key = normalizeText(alias);
        if (key.length >= 4 && normalizedTranscript.includes(` ${key} `) && (!bestAlias || key.length > bestAlias.length)) bestAlias = key;
      }
      if (bestAlias) exactMentions.push({ ...person, matchScore: Math.min(1, 0.88 + bestAlias.length / 200), origin: "voice-exact" });
    }
    if (exactMentions.length) return exactMentions.sort((left, right) => right.matchScore - left.matchScore || right.popularity - left.popularity).slice(0, limit);
    return searchPeople(transcript, { themeId, excluded, limit }).map((person) => ({ ...person, origin: "voice-fuzzy" }));
  }

  function exportOverlay() {
    const overlayPeople = people.filter((person) => person.source === "tmdb" || person.source === "manual");
    const overlayWorkIds = new Set(overlayPeople.flatMap((person) => person.credits));
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      people: overlayPeople.map(({ films, creditCount, matchScore, origin, ...person }) => person),
      works: [...overlayWorkIds].map((id) => worksById.get(id)).filter(Boolean),
    };
  }

  return {
    actors: people,
    people,
    films: works.map((work) => work.title),
    works,
    snapshotId: data.snapshotId ?? null,
    generatedAt: data.generatedAt ?? null,
    quality: data.quality ?? null,
    findActor,
    findPeople,
    findWork: (id) => worksById.get(id) ?? null,
    hasActor: (value, themeId = "classic") => Boolean(findActor(value, themeId)),
    isInTheme,
    matchMentions,
    searchActors: (query, options = {}) => searchPeople(query, options).map((person) => person.name),
    searchPeople,
    sharedFilms: (left, right, themeId = "classic") => sharedWorks(left, right, themeId).map((work) => work.title),
    sharedWorks,
    upsertPerson,
    upsertPeople: (incoming, upsertOptions = {}) => incoming.map((person) => upsertPerson(person, upsertOptions)).filter(Boolean),
    upsertWork,
    exportOverlay,
    stats: () => ({ people: people.length, works: works.length, credits: people.reduce((sum, person) => sum + person.creditCount, 0) }),
  };
}
