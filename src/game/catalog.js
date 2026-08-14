import { normalizeText } from "./identity.js";
import { isKnownKind, isWorkInScope, normalizeExtensions, scopeFromExtensions, WORK_KINDS, workKind } from "./work-kinds.js";

// v2 : les caches v1 ont été écrits par une version qui gravait « type: movie » sur tout ce qu'une source
// confirmait, séries et documentaires compris. Ils ne sont pas rattrapables entrée par entrée — rien n'y dit ce
// que l'œuvre était vraiment — donc ils sont abandonnés, et effacés pour rendre la place qu'ils occupent.
export const CATALOG_CACHE_KEY = "cinefil.catalog-cache.v2";
export const VERIFICATION_CACHE_KEY = "cinefil.verification-cache.v2";
const LEGACY_CACHE_KEYS = ["cinefil.catalog-cache.v1", "cinefil.verification-cache.v1"];
const MAX_CACHED_PEOPLE = 80;
const MAX_VERIFIED_LINKS = 200;

export function createVerificationSearchLinks(left, right) {
  const query = encodeURIComponent(`"${left}" "${right}" film`);
  return {
    google: `https://www.google.com/search?q=${query}`,
    duckduckgo: `https://duckduckgo.com/?q=${query}`,
    qwant: `https://www.qwant.com/?q=${query}`,
    wikipedia: `https://fr.wikipedia.org/w/index.php?search=${query}`,
  };
}

function verifiedPairKey(left, right) {
  return [
    `${normalizeText(left.name)}#${left.externalIds?.tmdb ?? left.id ?? ""}`,
    `${normalizeText(right.name)}#${right.externalIds?.tmdb ?? right.id ?? ""}`,
  ].sort().join("|");
}

function compactExternalIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 10).flatMap(([key, rawValue]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(key)) return [];
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return [[key, rawValue]];
    if (typeof rawValue === "string" && rawValue.length <= 100) return [[key, rawValue]];
    return [];
  }));
}

function compactSource(value, fallback = "verification") {
  const source = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return source || fallback;
}

function compactVerifiedPerson(person) {
  return {
    id: typeof person?.id === "string" && person.id.length <= 128 ? person.id : null,
    name: String(person?.name ?? "").trim().slice(0, 100),
    externalIds: compactExternalIds(person?.externalIds),
  };
}

// Une preuve retenue entre en base pour de bon : elle y sera relue à la partie suivante, hors connexion, sans que
// personne ne puisse plus la contester. Elle doit donc emporter ce qu'elle est — un film, un documentaire, une
// émission — et non le « film » que l'ancienne version écrivait d'office sur tout ce qui remontait.
function compactVerifiedFilm(film, source) {
  const title = String(typeof film === "string" ? film : film?.title ?? "").trim().slice(0, 200);
  if (!title) return null;
  const candidateYear = Number(film?.year);
  const qid = typeof film?.qid === "string" && /^Q\d{1,20}$/.test(film.qid) ? film.qid : null;
  const kind = isKnownKind(film?.kind) ? film.kind : WORK_KINDS.UNKNOWN;
  return {
    title,
    year: Number.isInteger(candidateYear) && candidateYear >= 1800 && candidateYear <= 2200 ? candidateYear : null,
    type: film?.type === "tv" ? "tv" : "movie",
    kind,
    source: compactSource(film?.source, compactSource(source)),
    externalIds: {
      ...compactExternalIds(film?.externalIds),
      ...(qid ? { wikidata: qid } : {}),
    },
  };
}

function compactVerifiedLink(link) {
  const left = compactVerifiedPerson(link?.left);
  const right = compactVerifiedPerson(link?.right);
  const films = (Array.isArray(link?.films) ? link.films : []).slice(0, 20).map((film) => compactVerifiedFilm(film, link?.source)).filter(Boolean);
  if (!left.name || !right.name || !films.length || normalizeText(left.name) === normalizeText(right.name)) return null;
  return {
    key: verifiedPairKey(left, right),
    left,
    right,
    films,
    source: compactSource(link?.source),
    confirmedAt: typeof link?.confirmedAt === "string" ? link.confirmedAt.slice(0, 40) : null,
  };
}

function applyVerifiedLink(database, link) {
  const works = (link?.films ?? []).map((film) => database.upsertWork(film, { source: film.source ?? link.source ?? "verification" })).filter(Boolean);
  if (!works.length) return false;
  for (const reference of [link.left, link.right]) {
    const existing = database.findActor(reference?.id) ?? database.findActor(reference?.name);
    if (!existing && !reference?.name) continue;
    database.upsertPerson({
      ...(existing ?? {}),
      id: existing?.id ?? reference.id ?? undefined,
      name: existing?.name ?? reference.name,
      externalIds: { ...(existing?.externalIds ?? {}), ...(reference.externalIds ?? {}) },
      credits: works,
    }, { source: existing?.source ?? "verification" });
  }
  return true;
}

export function createVerificationCache(storage = globalThis.localStorage) {
  function load() {
    const value = readJson(storage, VERIFICATION_CACHE_KEY, { version: 1, links: [] });
    if (value?.version !== 1 || !Array.isArray(value.links)) return { version: 1, links: [] };
    const links = value.links.slice(0, MAX_VERIFIED_LINKS).map(compactVerifiedLink).filter(Boolean);
    return { version: 1, savedAt: value.savedAt ?? null, links };
  }

  function save(leftPerson, rightPerson, verification) {
    const left = compactVerifiedPerson(leftPerson);
    const right = compactVerifiedPerson(rightPerson);
    const films = (Array.isArray(verification?.films) ? verification.films : []).map((film) => compactVerifiedFilm(film, verification.source)).filter(Boolean).slice(0, 20);
    if (!left.name || !right.name || !films.length || verification?.verdict !== "CONFIRMED") return null;
    const key = verifiedPairKey(left, right);
    const entry = { key, left, right, films, source: compactSource(verification.source), confirmedAt: new Date().toISOString() };
    const previous = load();
    const links = [entry, ...previous.links.filter((link) => link.key !== key)].slice(0, MAX_VERIFIED_LINKS);
    writeJson(storage, VERIFICATION_CACHE_KEY, { version: 1, savedAt: new Date().toISOString(), links });
    return entry;
  }

  return { load, save, clear: () => storage?.removeItem(VERIFICATION_CACHE_KEY) };
}

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A remote result remains usable for the current session when storage is full.
  }
}

export function createCatalogCache(storage = globalThis.localStorage) {
  function load() {
    const value = readJson(storage, CATALOG_CACHE_KEY, { version: 1, people: [] });
    return value?.version === 1 && Array.isArray(value.people) ? value : { version: 1, people: [] };
  }

  function savePerson(person) {
    const cache = load();
    const key = person.externalIds?.tmdb ? `tmdb:${person.externalIds.tmdb}` : normalizeText(person.name);
    const people = [person, ...cache.people.filter((entry) => {
      const entryKey = entry.externalIds?.tmdb ? `tmdb:${entry.externalIds.tmdb}` : normalizeText(entry.name);
      return entryKey !== key;
    })].slice(0, MAX_CACHED_PEOPLE);
    writeJson(storage, CATALOG_CACHE_KEY, { version: 1, savedAt: new Date().toISOString(), people });
  }

  return { load, savePerson, clear: () => storage?.removeItem(CATALOG_CACHE_KEY) };
}

// Le dernier filet, côté joueur. Une réponse de vérification est mise en cache une journée par le serveur et par
// le navigateur : une preuve calculée avant cette version, ou par un serveur plus ancien, peut donc encore
// arriver avec des œuvres hors périmètre. On les retire ici plutôt que de faire confiance à l'expéditeur, et un
// verdict qui n'a plus rien pour lui redevient une absence de preuve — jamais une preuve d'absence, que seule la
// table peut prononcer.
function inScope(payload, scope) {
  const films = (Array.isArray(payload?.films) ? payload.films : []).filter((film) => isWorkInScope(film, scope));
  if (films.length === (payload?.films?.length ?? 0)) return payload;
  const evidence = (Array.isArray(payload?.evidence) ? payload.evidence : []).filter((entry) => isWorkInScope(entry, scope));
  const kept = films.length > 0;
  return {
    ...payload,
    films,
    evidence,
    verdict: kept ? payload.verdict : payload.verdict === "UNKNOWN" ? "UNKNOWN" : "NOT_FOUND",
    source: kept ? payload.source : "none",
  };
}

export function createHybridCatalog({
  database,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  const cache = createCatalogCache(storage);
  const verificationCache = createVerificationCache(storage);
  for (const key of LEGACY_CACHE_KEYS) {
    try {
      storage?.removeItem(key);
    } catch {
      // Un stockage refusé ne doit pas empêcher la partie de démarrer : la version v1 sera simplement ignorée.
    }
  }
  const cached = cache.load();
  for (const person of cached.people) database.upsertPerson(person, { source: "tmdb" });
  for (const link of verificationCache.load().links) applyVerifiedLink(database, link);
  // The game is served by its own API, so the only question left is whether that API answers, and whether it
  // holds a TMDb key. Both are told to the player, so they belong to the state rather than to a guess.
  let remoteState = { checked: false, configured: null, online: globalThis.navigator?.onLine !== false, source: "local" };
  const setRemoteState = (patch) => { remoteState = { ...remoteState, ...patch }; };

  async function fetchJson(url, { signal } = {}) {
    if (!fetchImpl || globalThis.navigator?.onLine === false) throw new Error("offline");
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `catalog-${response.status}`);
    return payload;
  }

  async function status() {
    try {
      const payload = await fetchJson("/api/catalog/status");
      setRemoteState({ checked: true, configured: Boolean(payload.configured), online: true, source: payload.source ?? "local" });
    } catch {
      setRemoteState({ checked: true, online: false });
    }
    return { ...remoteState };
  }

  async function search(query, options = {}) {
    const limit = Math.max(1, Math.min(12, Number(options.limit ?? 8)));
    const local = database.searchPeople(query, { ...options, limit });
    // A browser that reports itself offline is not a catalogue that answers: saying so keeps the status line from
    // promising a live search that will never leave the device.
    if (globalThis.navigator?.onLine === false) setRemoteState({ checked: true, online: false });
    if (normalizeText(query).length < 2 || options.remote === false || globalThis.navigator?.onLine === false) {
      return { results: local, remote: { ...remoteState, skipped: true } };
    }
    try {
      const parameters = new URLSearchParams({ query, limit: String(limit), locale: options.locale ?? "fr-FR" });
      const payload = await fetchJson(`/api/catalog/search?${parameters}`, { signal: options.signal });
      setRemoteState({ checked: true, configured: Boolean(payload.configured), online: true, source: payload.source ?? "tmdb" });
      const merged = [...local];
      for (const person of payload.results ?? []) {
        const tmdbKey = person.externalIds?.tmdb ? `tmdb:${person.externalIds.tmdb}` : null;
        const index = merged.findIndex((entry) => (tmdbKey && String(entry.externalIds?.tmdb) === String(person.externalIds?.tmdb)) || normalizeText(entry.name) === normalizeText(person.name));
        if (index >= 0) {
          merged[index] = {
            ...merged[index],
            profilePath: merged[index].profilePath || person.profilePath,
            knownFor: person.knownFor ?? merged[index].knownFor,
            externalIds: { ...merged[index].externalIds, ...person.externalIds },
            origin: "local+tmdb",
          };
        } else merged.push(person);
      }
      return { results: merged.slice(0, limit), remote: { ...remoteState } };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      setRemoteState({ checked: true, online: false });
      return { results: local, remote: { ...remoteState, error: "unavailable" } };
    }
  }

  async function hydrate(candidate, { signal } = {}) {
    if (!candidate) return null;
    const existing = database.findActor(candidate.id) ?? database.findActor(candidate.name);
    if (existing?.id?.startsWith("person_") && existing.source !== "tmdb") {
      try {
        const payload = await fetchJson(`/api/catalog/people/local/${encodeURIComponent(existing.id)}`, { signal });
        const remotePerson = payload.person;
        const person = database.upsertPerson({
          ...remotePerson,
          id: existing.id,
          name: existing.name,
          aliases: [...new Set([...(remotePerson.aliases ?? []), remotePerson.name !== existing.name ? remotePerson.name : null].filter(Boolean))],
        }, { source: "tmdb" });
        cache.savePerson({ ...remotePerson, id: existing.id, name: existing.name });
        return person;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        setRemoteState({ checked: true, online: false });
        return existing;
      }
    }
    if (existing && existing.creditCount && !String(candidate.origin ?? "").includes("tmdb")) return existing;
    const tmdbId = candidate.externalIds?.tmdb;
    if (!tmdbId) return existing ?? database.upsertPerson(candidate, { source: candidate.source ?? "manual" });
    if (existing && String(existing.externalIds?.tmdb ?? "") === String(tmdbId) && existing.source === "tmdb") return existing;
    const cachedPerson = cache.load().people.find((person) => String(person.externalIds?.tmdb) === String(tmdbId));
    if (cachedPerson) return database.upsertPerson(cachedPerson, { source: "tmdb" });
    try {
      const payload = await fetchJson(`/api/catalog/people/tmdb/${encodeURIComponent(tmdbId)}`, { signal });
      const person = database.upsertPerson(payload.person, { source: "tmdb" });
      cache.savePerson(payload.person);
      return person;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // A filmography we could not fetch is not a reason to lose the name: the artist stays playable, and the
      // group can still vote on a link the catalogue cannot prove.
      setRemoteState({ checked: true, online: false });
      return existing ?? candidate;
    }
  }

  async function verifyLink(left, right, { locale = "fr-FR", signal, extensions = null } = {}) {
    const leftPerson = typeof left === "object" ? left : database.findActor(left);
    const rightPerson = typeof right === "object" ? right : database.findActor(right);
    const leftName = String(leftPerson?.name ?? left ?? "").trim();
    const rightName = String(rightPerson?.name ?? right ?? "").trim();
    const searchLinks = createVerificationSearchLinks(leftName, rightName);
    const activeExtensions = normalizeExtensions(extensions);
    const scope = scopeFromExtensions(activeExtensions);
    const localFilms = database.sharedWorks(leftPerson ?? leftName, rightPerson ?? rightName, "classic", { extensions: activeExtensions }).map((work) => ({
      title: work.title,
      year: work.year ?? null,
      kind: workKind(work),
      url: work.externalIds?.tmdbMovie ? `https://www.themoviedb.org/movie/${work.externalIds.tmdbMovie}` : null,
      source: "local",
    }));
    // The cascade always starts at home; recording that step keeps the trail readable even when it stops here.
    const localStep = { source: "local", outcome: localFilms.length ? "confirmed" : "empty", durationMs: 0, films: localFilms.length, error: null };
    const unreached = (source, outcome) => ({ source, outcome, durationMs: 0, films: 0, error: null });
    if (localFilms.length) {
      return { verdict: "CONFIRMED", source: "local", films: localFilms, evidence: localFilms, searchLinks, cached: true, durationMs: 0, steps: [localStep, unreached("tmdb", "not-reached"), unreached("wikidata", "not-reached"), unreached("wikipedia", "not-reached")] };
    }
    // Offline, the cascade is not "empty" — it was never asked. Saying so is what keeps an absence of network
    // from reading like an absence of film.
    if (globalThis.navigator?.onLine === false) {
      return { verdict: "UNKNOWN", source: "none", films: [], evidence: [], searchLinks, offline: true, steps: [localStep, unreached("tmdb", "error"), unreached("wikidata", "error"), unreached("wikipedia", "error")] };
    }
    try {
      // Le périmètre part avec la question : le serveur ne doit pas renvoyer — ni mettre en cache pour la table
      // suivante — une preuve que cette partie a décidé de ne pas jouer.
      const parameters = new URLSearchParams({ left: leftName, right: rightName, locale, scope: [...scope].sort().join(",") });
      if (leftPerson?.externalIds?.tmdb) parameters.set("leftTmdbId", leftPerson.externalIds.tmdb);
      if (rightPerson?.externalIds?.tmdb) parameters.set("rightTmdbId", rightPerson.externalIds.tmdb);
      const answer = inScope(await fetchJson(`/api/verify-link?${parameters}`, { signal }), scope);
      if (answer.verdict === "CONFIRMED") {
        const leftReference = leftPerson ?? { name: leftName };
        const rightReference = rightPerson ?? { name: rightName };
        const entry = verificationCache.save(leftReference, rightReference, answer);
        if (entry) applyVerifiedLink(database, entry);
      }
      return { ...answer, searchLinks: answer.searchLinks ?? searchLinks, steps: [localStep, ...(Array.isArray(answer.steps) ? answer.steps : [])] };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { verdict: "UNKNOWN", source: "none", films: [], evidence: [], searchLinks, error: "unavailable", steps: [localStep, unreached("tmdb", "error"), unreached("wikidata", "error"), unreached("wikipedia", "error")] };
    }
  }

  return {
    search,
    hydrate,
    verifyLink,
    status,
    getState: () => ({ ...remoteState }),
    clearCache: cache.clear,
    getVerificationCache: verificationCache.load,
    clearVerificationCache: verificationCache.clear,
  };
}
